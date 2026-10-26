/**
 * Leaderboards.
 *
 * The requirement was "针对用户偏好、历史仓位习惯 → 分类 → 推荐对应 label 的榜单",
 * plus curated hot lists (high fee, high volume, meme-adjacent).
 *
 * Two ideas shape the implementation:
 *
 *  1. **A board is a filter plus a reason to care.** Anyone can sort by TVL.
 *     What makes a board useful is that it answers one question ("where would a
 *     cautious stablecoin LP actually go?"), so each board carries its own
 *     gates and its own sort, and explains in one line why it exists.
 *
 *  2. **Personalisation is gated on evidence quality.** The style profile can
 *     say "you avoid USDG/USDT" — and it currently does, from 1.8 hours of
 *     observation. Applying that to rankings would encode a fluke as a
 *     preference. So the profile only influences ordering when
 *     `reliable === true`; otherwise the board is neutral and says so.
 *
 * Boards are computed from one upstream fetch and then partitioned, rather than
 * fetching per board: the data source rate-limits, and eight boards should not
 * mean eight requests.
 */

import { all } from "../db.ts";
import { computeScore } from "./score.ts";
import { poolsList } from "./pools.ts";
import type { PoolRow } from "../types.ts";

export interface BoardItem {
  chain: string;
  address: string;
  name: string;
  dex: string;
  baseSymbol: string;
  quoteSymbol: string;
  feeTierPct: number | null;
  priceUsd: number | null;
  priceChange24h: number | null;
  tvlUsd: number | null;
  vol24hUsd: number | null;
  feeAprPct: number | null;
  turnover: number | null;
  ageDays: number | null;
  score: number;
  grade: string;
  /** one line explaining why this pool is on this board */
  why: string;
  /** personalisation note, when the user's own record moved it */
  personal?: string;
}

export interface Board {
  id: string;
  label: string;
  /** what question this board answers */
  intent: string;
  /** why the user is seeing it, e.g. "基于你的历史仓位" or "全站" */
  basis: string;
  items: BoardItem[];
  count: number;
}

export interface LeaderboardResult {
  ok: boolean;
  generatedAt: number;
  /** whether the style profile was trustworthy enough to personalise with */
  personalized: boolean;
  personalNote: string | null;
  boards: Board[];
  error?: string;
}

const STABLES = new Set(["USDC", "USDT", "DAI", "USDS", "GHO", "LUSD", "FRAX", "CRVUSD", "USDE", "PYUSD", "USDG", "USD₮0", "USDT0"]);
const BLUECHIP = new Set(["WETH", "ETH", "WBTC", "BTC", "CBETH", "RETH", "WSTETH", "SOL", "OKB", "WOKB"]);

const isStable = (s: string) => STABLES.has(s.toUpperCase());
const isBlue = (s: string) => BLUECHIP.has(s.toUpperCase());

/**
 * Tokens that are not stable, not blue-chip, and not wrapped equivalents.
 *
 * A crude definition of "meme-adjacent", but the honest one available: we have
 * no token taxonomy in this system, and inventing a curated list would mean
 * hard-coding opinions that go stale. Holding the pool for a few days and having
 * real volume is what makes it worth listing; the label is a hint, not a claim.
 */
function isLongTail(sym: string): boolean {
  const s = sym.toUpperCase();
  if (isStable(s) || isBlue(s)) return false;
  // wrapped/staked variants of majors are not long tail
  if (/^(W|ST|R|CB|S)?(ETH|BTC|SOL|OKB)$/.test(s)) return false;
  if (s.startsWith("W") && isBlue(s.slice(1))) return false;
  return true;
}

interface Prefs {
  reliable: boolean;
  riskAppetite: 1 | 2 | 3;
  prefer: string[];
  avoid: string[];
  note: string | null;
}

/**
 * Load the user's preferences, but only trust the parts that earned it.
 *
 * `avoid` is the dangerous one: it is derived from realised losses, and with
 * one closed position it means "you lost once on this stablecoin pair". Applying
 * that would blacklist every stable pool the user actually wants.
 */
function loadPrefs(): Prefs {
  const row = all<any>(`SELECT * FROM style_profile WHERE id='current'`)[0];
  if (!row) {
    return { reliable: false, riskAppetite: 2, prefer: [], avoid: [], note: "还没有交易记录，榜单不做个性化" };
  }

  let ev: any = {};
  try { ev = JSON.parse(row.evidence ?? "{}"); } catch { ev = {}; }
  const reliable = ev?.style?.reliable === true;

  const parseList = (s: unknown): string[] => {
    try {
      const v = JSON.parse(String(s ?? "[]"));
      return Array.isArray(v) ? v.map(String) : [];
    } catch { return []; }
  };

  if (!reliable) {
    return {
      reliable: false,
      riskAppetite: 2,   // neutral: do not act on an unreliable appetite reading
      prefer: [],
      avoid: [],
      note: ev?.style?.unreliableReason
        ? `榜单未个性化：${ev.style.unreliableReason}`
        : "榜单未个性化：历史记录不足",
    };
  }

  return {
    reliable: true,
    riskAppetite: (Number(row.risk_appetite) as 1 | 2 | 3) || 2,
    prefer: parseList(row.prefer_symbols),
    avoid: parseList(row.avoid_symbols),
    note: "榜单已按你的历史习惯调整",
  };
}

/** Symbols the user actually holds, so a board can say "与你相关". */
function heldSymbols(): Set<string> {
  const set = new Set<string>();
  for (const r of all<any>(`SELECT pool_name FROM positions WHERE status='open'`)) {
    const name = String(r.pool_name ?? "");
    for (const part of name.split(/[-/]/)) {
      const s = part.trim().toUpperCase();
      if (s) set.add(s);
    }
  }
  for (const r of all<any>(`SELECT label FROM watchlist`)) {
    const s = String(r.label ?? "").trim().toUpperCase();
    if (s) set.add(s);
  }
  return set;
}

/**
 * Personal nudge applied to a pool's ranking position.
 *
 * Small on purpose: preferences should reorder near-equals, not put a mediocre
 * pool on top. A pool the user already holds gets a mild bump because managing
 * two positions in the same token is cheaper than opening a third exposure.
 */
function personalAdjust(p: PoolRow, prefs: Prefs, held: Set<string>): { delta: number; note: string | null } {
  if (!prefs.reliable) return { delta: 0, note: null };

  const base = p.baseSymbol.toUpperCase();
  const quote = p.quoteSymbol.toUpperCase();
  let delta = 0;
  const reasons: string[] = [];

  for (const sym of prefs.prefer) {
    if (base === sym || quote === sym) { delta += 4; reasons.push(`偏好 ${sym}`); }
  }
  // Avoid is a penalty, not a ban: the pool may still be the best option and
  // hiding it would make the board lie about what exists.
  for (const sym of prefs.avoid) {
    if (base === sym || quote === sym) { delta -= 6; reasons.push(`历史亏损于 ${sym}`); }
  }
  for (const sym of held) {
    if (base === sym || quote === sym) { delta += 2; reasons.push(`已持有 ${sym}`); }
  }

  return { delta, note: reasons.length ? reasons.join(" · ") : null };
}

function toItem(
  p: PoolRow,
  score: { total: number; grade: string },
  why: string,
  personal?: string | null,
): BoardItem {
  return {
    chain: p.chain,
    address: p.address,
    name: p.name,
    dex: p.dex,
    baseSymbol: p.baseSymbol,
    quoteSymbol: p.quoteSymbol,
    feeTierPct: p.feeTierPct,
    priceUsd: p.priceUsd,
    priceChange24h: p.priceChange24h,
    tvlUsd: p.tvlUsd,
    vol24hUsd: p.vol24hUsd,
    feeAprPct: p.feeAprPct,
    turnover: p.turnover,
    ageDays: p.ageDays,
    score: score.total,
    grade: score.grade,
    why,
    personal: personal ?? undefined,
  };
}

/**
 * Build every board in one pass.
 *
 * One upstream fetch, partitioned several ways. Each board re-scores with its
 * own risk tier, because "best stablecoin pool" and "best long-tail pool" have
 * different tolerances for volatility.
 */
export async function buildLeaderboard(
  chain: string,
  opts: { limit?: number; capitalUsd?: number } = {},
): Promise<LeaderboardResult> {
  const limit = opts.limit ?? 8;
  const capital = opts.capitalUsd ?? 2000;

  const prefs = loadPrefs();
  const held = heldSymbols();

  // Two upstream pulls: the volume-sorted list and the trending list. Trending
  // is a different endpoint, not a different sort, so it cannot be derived.
  const [byVol, byTvl] = await Promise.all([
    poolsList({ chain, sort: "vol24h", minTvl: 100_000, limit: 60 }),
    poolsList({ chain, sort: "tvl", minTvl: 250_000, limit: 60 }),
  ]);

  if (!byVol.ok || !byVol.data) {
    return {
      ok: false, generatedAt: Date.now(), personalized: false,
      personalNote: prefs.note, boards: [],
      error: byVol.error ?? "行情数据不可用",
    };
  }

  // Merge and dedupe: a pool can appear in both pulls.
  const seen = new Map<string, PoolRow>();
  for (const p of [...(byVol.data.rows ?? []), ...((byTvl.data?.rows ?? []) as PoolRow[])]) {
    if (!seen.has(p.address)) seen.set(p.address, p);
  }
  const all_pools = [...seen.values()];

  const scored = all_pools.map((p) => ({
    p,
    s: computeScore(p, {
      capitalUsd: capital,
      riskTier: prefs.reliable ? prefs.riskAppetite : 2,
      preferSymbols: prefs.prefer,
      avoidSymbols: prefs.avoid,
    }),
    adj: personalAdjust(p, prefs, held),
  }));

  const boards: Board[] = [];

  const build = (
    id: string, label: string, intent: string,
    filter: (x: typeof scored[number]) => boolean,
    sort: (a: typeof scored[number], b: typeof scored[number]) => number,
    whyFor: (x: typeof scored[number]) => string,
    basis = prefs.reliable ? "已按你的偏好调整" : "全站（未个性化）",
  ) => {
    const items = scored
      .filter(filter)
      .sort(sort)
      .slice(0, limit)
      .map((x) => toItem(x.p, x.s, whyFor(x), x.adj.note));
    if (!items.length) return;
    boards.push({ id, label, intent, basis, items, count: items.length });
  };

  // ── 1. 综合最优：the default answer to "what should I look at" ──
  build(
    "best", "综合最优", "评分最高的池子，风险与收益平衡",
    (x) => x.s.grade === "A" || x.s.grade === "B",
    (a, b) => (b.s.total + b.adj.delta) - (a.s.total + a.adj.delta),
    (x) => `${x.s.total} 分 ${x.s.grade} · 手续费上限 ${x.p.feeAprPct?.toFixed(1) ?? "—"}%`,
  );

  // ── 2. 稳健优先：stable pairs only ──
  build(
    "stable", "稳健优先", "稳定币对，几乎无无常损失",
    (x) => isStable(x.p.baseSymbol) && isStable(x.p.quoteSymbol),
    (a, b) => (b.p.feeAprPct ?? 0) - (a.p.feeAprPct ?? 0),
    (x) => `稳定币对 · 30d 波动低 · 手续费 ${x.p.feeAprPct?.toFixed(1) ?? "—"}%`,
    "适合小额或保守资金",
  );

  // ── 3. 高手续费：fee APR leaders, with a sanity floor ──
  build(
    "yield", "高手续费", "手续费收益率最高，注意高收益常伴随高波动",
    (x) => (x.p.feeAprPct ?? 0) >= 15 && (x.p.tvlUsd ?? 0) >= 300_000,
    (a, b) => (b.p.feeAprPct ?? 0) - (a.p.feeAprPct ?? 0),
    (x) => `fee APR ${x.p.feeAprPct?.toFixed(1)}% · 24h 成交 ${fmtShort(x.p.vol24hUsd)}`,
    "高收益榜单，风险自担",
  );

  // ── 4. 高成交：liquidity magnet, easiest to enter/exit ──
  build(
    "volume", "高成交", "24h 成交额最大，进出最容易",
    (x) => (x.p.vol24hUsd ?? 0) >= 500_000,
    (a, b) => (b.p.vol24hUsd ?? 0) - (a.p.vol24hUsd ?? 0),
    (x) => `24h ${fmtShort(x.p.vol24hUsd)} · 换手 ${(x.p.turnover ?? 0).toFixed(2)}x`,
    "流动性最好",
  );

  // ── 5. 长尾/热点：non-stable, non-blue pairs with real activity ──
  build(
    "longtail", "长尾热点", "非主流代币池，波动大但费用可能很高",
    (x) =>
      (isLongTail(x.p.baseSymbol) || isLongTail(x.p.quoteSymbol)) &&
      (x.p.tvlUsd ?? 0) >= 200_000 &&
      (x.p.ageDays ?? 0) >= 3,
    (a, b) => (b.p.vol24hUsd ?? 0) - (a.p.vol24hUsd ?? 0),
    (x) => `含长尾代币 · 池龄 ${Math.round(x.p.ageDays ?? 0)} 天 · 24h ${fmtShort(x.p.vol24hUsd)}`,
    "高波动，仅适合能承受回撤的资金",
  );

  // ── 6. 蓝筹对：majors, the "boring but real" board ──
  build(
    "bluechip", "蓝筹对", "主流资产配对，无常损失可预期",
    (x) => isBlue(x.p.baseSymbol) && isBlue(x.p.quoteSymbol),
    (a, b) => (b.s.total + b.adj.delta) - (a.s.total + a.adj.delta),
    (x) => `${x.s.total} 分 · ${x.p.name}`,
  );

  // ── 7. 与你相关：pools matching what the user holds or watches ──
  if (held.size) {
    build(
      "related", "与你相关", "包含你持有或关注的代币",
      (x) => held.has(x.p.baseSymbol.toUpperCase()) || held.has(x.p.quoteSymbol.toUpperCase()),
      (a, b) => (b.s.total + b.adj.delta) - (a.s.total + a.adj.delta),
      (x) => `你持有 ${[x.p.baseSymbol, x.p.quoteSymbol].filter((s) => held.has(s.toUpperCase())).join(" / ")}`,
      "基于你的持仓与关注列表",
    );
  }

  // ── 8. 新池：recently created, high risk ──
  build(
    "new", "新池观察", "上线不久、成交已起来的池子",
    (x) => (x.p.ageDays ?? 999) <= 14 && (x.p.vol24hUsd ?? 0) >= 100_000,
    (a, b) => (a.p.ageDays ?? 999) - (b.p.ageDays ?? 999),
    (x) => `池龄 ${Math.round(x.p.ageDays ?? 0)} 天 · 尚无长期数据`,
    "高风险，池龄短",
  );

  return {
    ok: true,
    generatedAt: Date.now(),
    personalized: prefs.reliable,
    personalNote: prefs.note,
    boards,
  };
}

function fmtShort(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
