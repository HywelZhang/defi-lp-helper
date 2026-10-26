/**
 * Review layer: turn what happened into something the user can learn from.
 *
 * Three scopes, one principle — the deterministic facts are computed here and
 * the LLM only interprets them, never invents a number:
 *
 *   position → did this one trade work, and where did the money actually go
 *   period   → weekly/monthly aggregation across positions
 *   style    → what the realised record says about how this user trades
 *
 * The style profile is not decoration: it feeds back into scoring (riskTier,
 * preferSymbols) and into the research evidence, so reviews change what gets
 * recommended next.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chat } from "../llm.ts";
import { one, all, run } from "../db.ts";
import { sha, fmtUsd, fmtPct, truncate } from "../util.ts";
import { numberAllowed, numbersIn } from "../validator.ts";

const SKILLS_DIR = resolve(new URL("../../skills", import.meta.url).pathname);

export interface ReviewFacts {
  version: string;
  scope: "position" | "period" | "style";
  subjectId: string;
  subjectLabel: string;
  /** human/LLM readable, always derived from stored data */
  facts: Record<string, string | number | null>;
  /** every number allowed to appear in prose */
  allowedNumbers: number[];
  sections: Record<string, unknown>;
  /** what we could not measure — stated, never papered over */
  gaps: string[];
  generatedAt: number;
}

export interface ReviewClaim { text: string; refs: string[] }

export interface ReviewReport {
  verdict: "good" | "neutral" | "bad" | "mixed";
  headline: string;
  whatWorked: ReviewClaim[];
  whatDidnt: ReviewClaim[];
  costAnalysis: ReviewClaim[];
  lesson: ReviewClaim[];
  nextTime: ReviewClaim[];
  gaps: string[];
}

export interface ReviewResult {
  ok: boolean;
  scope: "position" | "period" | "style";
  subjectId: string;
  subjectLabel: string;
  facts: ReviewFacts;
  report: ReviewReport | null;
  issues: { code: string; detail: string }[];
  degraded: boolean;
  degradeReason?: string;
  cached: boolean;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  tookMs: number;
  reviewId?: string;
}

function loadSkill(name: string): { text: string; version: string } {
  const p = resolve(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(p)) return { text: "", version: "missing" };
  const text = readFileSync(p, "utf8");
  return { text, version: sha(text, 12) };
}

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Sum every number we place into facts, so the validator can authorise them. */
function collectNumbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  else if (typeof v === "string") out.push(...numbersIn(v));
  else if (Array.isArray(v)) for (const x of v) collectNumbers(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectNumbers(x, out);
  return out;
}

function dedupe(nums: number[]): number[] {
  const set = new Set<number>();
  for (const n of nums) if (Number.isFinite(n)) set.add(Math.round(n * 1e6) / 1e6);
  return [...set];
}

/* ─────────────────────────── position facts ─────────────────────────── */

interface PositionRow {
  id: string; plan_id: string | null; chain: string; address: string;
  investment_id: number | null; token_id: string | null;
  platform_name: string | null; pool_name: string | null;
  value_usd: number; tokens_json: string; status: string;
  opened_at: number; closed_at: number | null;
  cost_usd: number | null; proceeds_usd: number | null;
  cash_back_usd: number | null; rebalance_json: string | null;
  tick_lower: number | null; tick_upper: number | null;
  fees_usd: number | null;
}

export function buildPositionFacts(positionId: string): ReviewFacts | { error: string } {
  const p = one<PositionRow>(`SELECT * FROM positions WHERE id=?`, positionId);
  if (!p) return { error: `仓位 ${positionId} 不存在` };

  const events = all<any>(
    `SELECT kind, amount_usd, note, created_at FROM position_events WHERE position_id=? ORDER BY created_at`,
    positionId,
  );
  const plan = p.plan_id
    ? one<any>(`SELECT * FROM plans WHERE id=?`, p.plan_id)
    : null;

  const openedAt = Number(p.opened_at);
  const endAt = p.closed_at ? Number(p.closed_at) : Date.now();
  const holdHours = Math.max(0, (endAt - openedAt) / 3600_000);
  const isClosed = p.status !== "open";

  const rebalances = events.filter((e) => e.kind === "range_adjust").length;
  const withdraws = events.filter((e) => e.kind === "withdraw").length;
  const collects = events.filter((e) => e.kind === "collect").length;

  // Money in / money out. Proceeds only exists once closed; an open position is
  // marked at current value plus whatever a past rebalance left in the wallet.
  const cost = Number(p.cost_usd ?? NaN) || Number(plan?.real_cost_usd ?? NaN) || null;
  const cashBack = Number(p.cash_back_usd ?? 0) || 0;
  const proceeds = Number(p.proceeds_usd ?? NaN);
  const current = Number(p.value_usd ?? 0) || 0;
  const recovered = isClosed && Number.isFinite(proceeds) ? proceeds : current + cashBack;
  const pnl = cost != null ? recovered - cost : null;
  const pnlPct = cost && cost > 0 ? (pnl! / cost) * 100 : null;

  // What the plan promised, so the review can compare promise to outcome.
  const planPayload = parseJson<any>(plan?.payload, {});
  const expectedFee = Number(plan?.expected_fee_usd ?? NaN);
  const expectedIl = Number(plan?.expected_il_usd ?? NaN);
  const expectedNet = Number(plan?.net_usd ?? NaN);
  const plannedHoldDays = Number(plan?.hold_days ?? NaN);
  // Fees are not booked as their own line yet, so a "fee share of PnL" number
  // here would be invented. Left null on purpose; the gap is declared instead.
  const feeShare: number | null = null;

  // Range history from the rebalance intents — the only reliable record of where
  // the position actually sat over time.
  const rangeHistory: { lower: number; upper: number; at: number }[] = [];
  const intent = parseJson<any>(p.rebalance_json, null);
  if (intent?.ticks) {
    rangeHistory.push({ lower: intent.ticks.tickLower, upper: intent.ticks.tickUpper, at: intent.startedAt ?? openedAt });
  }

  const tokens = parseJson<any[]>(p.tokens_json, []);
  const tokenLine = tokens.map((t) => `${t.symbol} ${Number(t.amount ?? 0).toFixed(6)}`).join(" / ");

  const facts: Record<string, string | number | null> = {
    "池子": p.pool_name ?? "—",
    "平台": p.platform_name ?? "—",
    "NFT": p.token_id ?? "—",
    "状态": isClosed ? "已平仓" : "持有中",
    "持有小时": Math.round(holdHours * 10) / 10,
    "持有天": Math.round((holdHours / 24) * 100) / 100,
    "投入成本": cost == null ? null : fmtUsd(cost, 6),
    "已回收": fmtUsd(recovered, 6),
    "当前市值": fmtUsd(current, 6),
    "未投入现金": fmtUsd(cashBack, 6),
    "盈亏": pnl == null ? null : fmtUsd(pnl, 6),
    "盈亏比": pnlPct == null ? null : fmtPct(pnlPct, 3),
    "调仓次数": rebalances,
    "撤仓次数": withdraws,
    "领取次数": collects,
    "当前区间下界": p.tick_lower,
    "当前区间上界": p.tick_upper,
    "计划评分": plan?.score ?? null,
    "计划等级": plan?.grade ?? null,
    "计划预期手续费": Number.isFinite(expectedFee) ? fmtUsd(expectedFee, 6) : null,
    "计划预期IL": Number.isFinite(expectedIl) ? fmtUsd(expectedIl, 6) : null,
    "计划预期净收益": Number.isFinite(expectedNet) ? fmtUsd(expectedNet, 6) : null,
    "计划持有天数": Number.isFinite(plannedHoldDays) ? plannedHoldDays : null,
    "持仓成分": tokenLine || null,
  };

  const sections = {
    position: {
      id: p.id,
      pool: p.pool_name,
      status: p.status,
      holdHours: Math.round(holdHours * 10) / 10,
      costUsd: cost,
      recoveredUsd: Math.round(recovered * 1e6) / 1e6,
      currentUsd: current,
      cashBackUsd: cashBack,
      pnlUsd: pnl == null ? null : Math.round(pnl * 1e6) / 1e6,
      pnlPct: pnlPct == null ? null : Math.round(pnlPct * 1000) / 1000,
      feeSharePct: feeShare == null ? null : Math.round(feeShare * 1000) / 1000,
      rebalances, withdraws, collects,
      ticks: { lower: p.tick_lower, upper: p.tick_upper },
      rangeHistory,
      tokens,
    },
    plan: plan ? {
      id: plan.id, score: plan.score, grade: plan.grade,
      holdDays: Number.isFinite(plannedHoldDays) ? plannedHoldDays : null,
      expectedFeeUsd: Number.isFinite(expectedFee) ? expectedFee : null,
      expectedIlUsd: Number.isFinite(expectedIl) ? expectedIl : null,
      expectedNetUsd: Number.isFinite(expectedNet) ? expectedNet : null,
      entryPrice: plan.entry_price, lowerPrice: plan.lower_price, upperPrice: plan.upper_price,
      rangeDownPct: plan.range_down_pct, rangeUpPct: plan.range_up_pct,
      verdict: planPayload?.verdict ?? null,
    } : null,
    timeline: events.map((e) => ({ kind: e.kind, at: e.created_at, note: e.note })),
  };

  // Be explicit about what this review cannot see.
  const gaps: string[] = [];
  gaps.push("没有存储历史价格序列，因此无法计算价格在区间内的实际停留时间");
  gaps.push("未领取手续费未单独入账，收费贡献只能从总盈亏反推");
  if (!plan) gaps.push("该仓位没有关联计划，无法对比预期与实际");
  if (rebalances === 0) gaps.push("该仓位从未调仓，区间有效性只能由最终结果间接判断");

  return {
    version: "review@1",
    scope: "position",
    subjectId: p.id,
    subjectLabel: `${p.pool_name ?? "未知池子"} · ${p.token_id ? "NFT #" + p.token_id : p.id.slice(0, 12)}`,
    facts,
    allowedNumbers: dedupe(collectNumbers({ facts, sections })),
    sections,
    gaps,
    generatedAt: Date.now(),
  };
}

/* ─────────────────────────── period facts ─────────────────────────── */

export function buildPeriodFacts(startMs: number, endMs: number): ReviewFacts {
  const rows = all<PositionRow>(
    `SELECT * FROM positions WHERE opened_at >= ? AND opened_at <= ? ORDER BY opened_at`,
    startMs, endMs,
  );

  const closed = rows.filter((r) => r.status !== "open");
  const open = rows.filter((r) => r.status === "open");

  let cost = 0, recovered = 0, pnl = 0;
  const perPosition: any[] = [];
  let rebalanceTotal = 0;

  for (const p of rows) {
    const plan = p.plan_id ? one<any>(`SELECT id,score,grade FROM plans WHERE id=?`, p.plan_id) : null;
    const c = Number(p.cost_usd ?? NaN) || null;
    const cashBack = Number(p.cash_back_usd ?? 0) || 0;
    const proceeds = Number(p.proceeds_usd ?? NaN);
    const isClosed = p.status !== "open";
    const rec = isClosed && Number.isFinite(proceeds)
      ? proceeds
      : Number(p.value_usd ?? 0) + cashBack;
    const pnlv = c != null ? rec - c : null;

    const evs = all<any>(`SELECT kind FROM position_events WHERE position_id=?`, p.id);
    const rb = evs.filter((e) => e.kind === "range_adjust").length;
    rebalanceTotal += rb;

    if (c != null) cost += c;
    recovered += rec;
    if (pnlv != null) pnl += pnlv;

    perPosition.push({
      id: p.id,
      pool: p.pool_name,
      status: p.status,
      costUsd: c,
      recoveredUsd: Math.round(rec * 1e6) / 1e6,
      pnlUsd: pnlv == null ? null : Math.round(pnlv * 1e6) / 1e6,
      pnlPct: c && c > 0 && pnlv != null ? Math.round((pnlv / c) * 100 * 1000) / 1000 : null,
      rebalances: rb,
      grade: plan?.grade ?? null,
      score: plan?.score ?? null,
      holdHours: Math.round(((p.closed_at ? Number(p.closed_at) : Date.now()) - Number(p.opened_at)) / 3600_000),
    });
  }

  const wins = perPosition.filter((x) => (x.pnlUsd ?? 0) > 0).length;
  const losses = perPosition.filter((x) => (x.pnlUsd ?? 0) < 0).length;
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : null;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : null;

  // Groups by pool: repeating the same pool is a behaviour signal worth naming.
  const byPool = new Map<string, number>();
  for (const p of rows) byPool.set(p.pool_name ?? "—", (byPool.get(p.pool_name ?? "—") ?? 0) + 1);
  const poolConcentration = [...byPool.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, count: n }));

  const days = Math.max(1, Math.round((endMs - startMs) / 86_400_000));
  const label = `${new Date(startMs).toISOString().slice(0, 10)} ~ ${new Date(endMs).toISOString().slice(0, 10)}`;

  const facts: Record<string, string | number | null> = {
    "统计区间": label,
    "天数": days,
    "仓位总数": rows.length,
    "已平仓": closed.length,
    "持有中": open.length,
    "投入成本合计": fmtUsd(cost, 6),
    "已回收合计": fmtUsd(recovered, 6),
    "盈亏合计": fmtUsd(pnl, 6),
    "盈亏比": pnlPct == null ? null : fmtPct(pnlPct, 3),
    "盈利笔数": wins,
    "亏损笔数": losses,
    "胜率": winRate == null ? null : fmtPct(winRate, 1),
    "调仓总次数": rebalanceTotal,
    "平均每仓调仓": rows.length ? Math.round((rebalanceTotal / rows.length) * 100) / 100 : null,
    "最活跃池子": poolConcentration[0]?.name ?? null,
  };

  const sections = {
    period: { startMs, endMs, days, label },
    totals: {
      positions: rows.length, closed: closed.length, open: open.length,
      costUsd: Math.round(cost * 1e6) / 1e6,
      recoveredUsd: Math.round(recovered * 1e6) / 1e6,
      pnlUsd: Math.round(pnl * 1e6) / 1e6,
      pnlPct: pnlPct == null ? null : Math.round(pnlPct * 1000) / 1000,
      wins, losses, winRate: winRate == null ? null : Math.round(winRate * 10) / 10,
      rebalanceTotal,
    },
    positions: perPosition,
    poolConcentration,
  };

  const gaps: string[] = [];
  if (!rows.length) gaps.push("该区间内没有任何仓位，无法形成复盘结论");
  if (decided === 0) gaps.push("该区间内没有已了结的仓位，胜率无意义");
  if (days < 7) gaps.push("统计区间短于 7 天，结论的统计意义有限");
  gaps.push("手续费收入未单独入账，收益构成只能从总盈亏推断");

  return {
    version: "review@1",
    scope: "period",
    subjectId: `${startMs}-${endMs}`,
    subjectLabel: `阶段性复盘 ${label}`,
    facts,
    allowedNumbers: dedupe(collectNumbers({ facts, sections })),
    sections,
    gaps,
    generatedAt: Date.now(),
  };
}

/* ─────────────────────────── style profile ─────────────────────────── */

export interface StyleProfile {
  /**
   * Whether this profile is fit to influence recommendations.
   *
   * Test bursts poison the signal: three positions opened within the same hour
   * look like "aggressive, holds 30 minutes, over-trades" when in fact nothing
   * was ever held. A profile derived from that would silently reshape scoring.
   */
  reliable: boolean;
  unreliableReason?: string;
  /** wall-clock span the observations cover */
  observedSpanHours: number;
  riskAppetite: 1 | 2 | 3;
  preferSymbols: string[];
  avoidSymbols: string[];
  medianHoldHours: number | null;
  rebalanceFrequency: number | null;
  winRate: number | null;
  avgRealisedPnlPct: number | null;
  positionsObserved: number;
  closedObserved: number;
  notes: string;
}

/**
 * Distil behaviour from the realised record.
 *
 * Deliberately arithmetic, not LLM: this value changes scoring, so it must be
 * reproducible and explainable. The LLM only writes commentary on top.
 */
export function deriveStyleProfile(): StyleProfile {
  const rows = all<any>(`SELECT * FROM positions ORDER BY opened_at DESC`);

  const holds: number[] = [];
  const rbCounts: number[] = [];
  const pnls: number[] = [];
  const poolCount = new Map<string, number>();
  const pnlByPool = new Map<string, { sum: number; n: number }>();
  let closed = 0, wins = 0, losses = 0;

  for (const p of rows) {
    const opened = Number(p.opened_at);
    const end = p.closed_at ? Number(p.closed_at) : Date.now();
    holds.push((end - opened) / 3600_000);

    const evs = all<any>(`SELECT kind FROM position_events WHERE position_id=?`, p.id);
    rbCounts.push(evs.filter((e) => e.kind === "range_adjust").length);

    // Pool name like "USDG-USDT" — split into the symbols actually traded.
    const name = String(p.pool_name ?? "");
    const parts = name.split(/[-/]/).map((s) => s.trim()).filter(Boolean);
    for (const s of parts) poolCount.set(s, (poolCount.get(s) ?? 0) + 1);

    const c = Number(p.cost_usd ?? NaN);
    if (!Number.isFinite(c) || c <= 0) continue;
    const cashBack = Number(p.cash_back_usd ?? 0) || 0;
    const proceeds = Number(p.proceeds_usd ?? NaN);
    const isClosed = p.status !== "open";
    const rec = isClosed && Number.isFinite(proceeds) ? proceeds : Number(p.value_usd ?? 0) + cashBack;
    const pct = ((rec - c) / c) * 100;

    pnls.push(pct);
    if (isClosed) {
      closed++;
      if (rec - c > 0) wins++;
      else if (rec - c < 0) losses++;
    }
    for (const s of parts) {
      const cur = pnlByPool.get(s) ?? { sum: 0, n: 0 };
      pnlByPool.set(s, { sum: cur.sum + pct, n: cur.n + 1 });
    }
  }

  const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;

  // How long did these observations actually span? A pile of positions opened
  // and closed inside one afternoon says nothing about how someone trades.
  let minOpen = Infinity, maxOpen = -Infinity;
  for (const p of rows) {
    const o = Number(p.opened_at);
    const c = p.closed_at ? Number(p.closed_at) : Date.now();
    if (Number.isFinite(o)) { minOpen = Math.min(minOpen, o); maxOpen = Math.max(maxOpen, c); }
  }
  const observedSpanHours = rows.length && Number.isFinite(minOpen)
    ? Math.max(0, (maxOpen - minOpen) / 3600_000)
    : 0;
  const avgPnl = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
  const rbFreq = rbCounts.length ? rbCounts.reduce((a, b) => a + b, 0) / rbCounts.length : null;
  const medHold = median(holds);

  // Symbols that repeatedly lost are candidates to avoid; repeating winners get
  // a mild preference. Threshold is intentionally blunt — with a handful of
  // positions anything finer would be noise dressed as insight.
  const prefer: string[] = [];
  const avoid: string[] = [];
  for (const [sym, st] of pnlByPool) {
    if (st.n < 2) continue;
    const avg = st.sum / st.n;
    if (avg > 0.5) prefer.push(sym);
    else if (avg < -0.5) avoid.push(sym);
  }

  // Risk appetite from observed behaviour: wide ranges + frequent rebalancing +
  // volatile pairs all point the same direction.
  let risk = 2;
  if (medHold != null && medHold < 48) risk += 1;
  if (rbFreq != null && rbFreq > 2) risk += 1;
  if (medHold != null && medHold > 24 * 14) risk -= 1;
  risk = Math.max(1, Math.min(3, risk)) as 1 | 2 | 3;

  // Two independent reasons to distrust the profile. Either one is enough to
  // stop it from feeding scoring — a wrong style profile is worse than none,
  // because it looks authoritative.
  const reasons: string[] = [];
  if (rows.length < 3) reasons.push(`仅 ${rows.length} 个仓位，样本不足`);
  if (observedSpanHours < 24) reasons.push(`观察窗口仅 ${Math.round(observedSpanHours * 10) / 10} 小时，不足以反映真实习惯`);
  const reliable = reasons.length === 0;

  return {
    reliable,
    unreliableReason: reliable ? undefined : reasons.join("；"),
    observedSpanHours: Math.round(observedSpanHours * 10) / 10,
    riskAppetite: risk,
    preferSymbols: prefer.slice(0, 5),
    avoidSymbols: avoid.slice(0, 5),
    medianHoldHours: medHold == null ? null : Math.round(medHold * 10) / 10,
    rebalanceFrequency: rbFreq == null ? null : Math.round(rbFreq * 100) / 100,
    winRate: winRate == null ? null : Math.round(winRate * 10) / 10,
    avgRealisedPnlPct: avgPnl == null ? null : Math.round(avgPnl * 1000) / 1000,
    positionsObserved: rows.length,
    closedObserved: closed,
    notes: rows.length < 3
      ? "样本不足 3 个仓位，风格判断仅供参考"
      : "",
  };
}

export function saveStyleProfile(p: StyleProfile, evidence: unknown) {
  run(
    `INSERT OR REPLACE INTO style_profile
     (id,created_at,positions_observed,closed_observed,risk_appetite,prefer_symbols,avoid_symbols,
      median_hold_hours,rebalance_frequency,win_rate,avg_realised_pnl_pct,fee_share_of_pnl,evidence,notes)
     VALUES ('current',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    Date.now(), p.positionsObserved, p.closedObserved, p.riskAppetite,
    JSON.stringify(p.preferSymbols), JSON.stringify(p.avoidSymbols),
    p.medianHoldHours, p.rebalanceFrequency, p.winRate, p.avgRealisedPnlPct,
    null,
    JSON.stringify({ ...(evidence as any), reliable: p.reliable, unreliableReason: p.unreliableReason ?? null, observedSpanHours: p.observedSpanHours }),
    p.notes,
  );
}

export function loadStyleProfile(): { profile: StyleProfile; createdAt: number } | null {
  const r = one<any>(`SELECT * FROM style_profile WHERE id='current'`);
  if (!r) return null;
  const ev = parseJson<any>(r.evidence, {});
  return {
    createdAt: Number(r.created_at),
    profile: {
      reliable: Boolean(ev?.reliable),
      unreliableReason: ev?.unreliableReason ?? undefined,
      observedSpanHours: Number(ev?.observedSpanHours ?? 0),
      riskAppetite: (Number(r.risk_appetite) || 2) as 1 | 2 | 3,
      preferSymbols: parseJson<string[]>(r.prefer_symbols, []),
      avoidSymbols: parseJson<string[]>(r.avoid_symbols, []),
      medianHoldHours: r.median_hold_hours == null ? null : Number(r.median_hold_hours),
      rebalanceFrequency: r.rebalance_frequency == null ? null : Number(r.rebalance_frequency),
      winRate: r.win_rate == null ? null : Number(r.win_rate),
      avgRealisedPnlPct: r.avg_realised_pnl_pct == null ? null : Number(r.avg_realised_pnl_pct),
      positionsObserved: Number(r.positions_observed) || 0,
      closedObserved: Number(r.closed_observed) || 0,
      notes: String(r.notes ?? ""),
    },
  };
}

/* ─────────────────────────── prompt + model ─────────────────────────── */

const OUTPUT_CONTRACT = `只输出一个完整的 JSON 对象，不要任何解释文字、不要 markdown 代码块围栏。

{
  "verdict": "good | neutral | bad | mixed",
  "headline": "一句话结论，必须带关键数字",
  "whatWorked":   [{"text": "...", "refs": ["字段名"]}],
  "whatDidnt":    [{"text": "...", "refs": ["字段名"]}],
  "costAnalysis": [{"text": "...", "refs": ["字段名"]}],
  "lesson":       [{"text": "...", "refs": ["字段名"]}],
  "nextTime":     [{"text": "...", "refs": ["字段名"]}],
  "gaps": ["..."]
}

硬性规则：
1. 任何数字必须出现在「允许引用的数字」中。
2. 每条判断至少给一个 refs，refs 必须是事实包里的字段名。
3. 亏损必须直说，不许用"接近平衡""基本符合预期"软化。
4. 不许描述事实包里没有的过程（例如区间停留时间）。
5. 保持简洁：每条不超过 60 字，段落数量按 skill 的要求。
6. 输出必须是完整闭合的 JSON。`;

function renderFacts(f: ReviewFacts): string {
  const lines: string[] = [];
  lines.push(`## 复盘对象\n${f.subjectLabel}（${f.scope}）`);

  lines.push(`\n## 事实`);
  for (const [k, v] of Object.entries(f.facts)) {
    if (v === null || v === "") continue;
    lines.push(`- ${k}: ${v}`);
  }

  const sec = f.sections as any;
  if (sec.position) {
    const p = sec.position;
    lines.push(`\n## 仓位细节`);
    lines.push(`- 状态: ${p.status}`);
    lines.push(`- 持有 ${p.holdHours} 小时`);
    lines.push(`- 投入 ${p.costUsd} / 回收 ${p.recoveredUsd} / 当前市值 ${p.currentUsd}`);
    lines.push(`- 未投入现金（调仓残留）: ${p.cashBackUsd}`);
    lines.push(`- 盈亏 ${p.pnlUsd} (${p.pnlPct}%)`);
    lines.push(`- 操作: 调仓 ${p.rebalances} 次 / 撤仓 ${p.withdraws} 次 / 领取 ${p.collects} 次`);
    lines.push(`- 区间: ${p.ticks?.lower} .. ${p.ticks?.upper}`);
  }
  if (sec.plan) {
    const q = sec.plan;
    lines.push(`\n## 当初的计划`);
    lines.push(`- 评分 ${q.score}（${q.grade}），计划持有 ${q.holdDays} 天`);
    lines.push(`- 预期手续费 ${q.expectedFeeUsd} / 预期 IL ${q.expectedIlUsd} / 预期净收益 ${q.expectedNetUsd}`);
    lines.push(`- 计划区间 ${q.rangeDownPct}% ~ +${q.rangeUpPct}%`);
  }
  if (sec.totals) {
    const t = sec.totals;
    lines.push(`\n## 区间汇总`);
    lines.push(`- 仓位 ${t.positions} 个（已平 ${t.closed} / 持有 ${t.open}）`);
    lines.push(`- 投入 ${t.costUsd} / 回收 ${t.recoveredUsd} / 净 ${t.pnlUsd} (${t.pnlPct}%)`);
    lines.push(`- 盈利 ${t.wins} 笔 / 亏损 ${t.losses} 笔 / 胜率 ${t.winRate}%`);
    lines.push(`- 调仓合计 ${t.rebalanceTotal} 次`);
  }
  if (Array.isArray(sec.positions) && sec.positions.length) {
    lines.push(`\n## 逐笔`);
    for (const p of sec.positions.slice(0, 12)) {
      lines.push(`- ${p.pool}: 投入 ${p.costUsd}, 盈亏 ${p.pnlUsd} (${p.pnlPct}%), 调仓 ${p.rebalances} 次, 评分 ${p.score ?? "—"}`);
    }
  }
  if (Array.isArray(sec.poolConcentration) && sec.poolConcentration.length) {
    lines.push(`\n## 池子集中度`);
    for (const x of sec.poolConcentration) lines.push(`- ${x.name}: ${x.count} 个仓位`);
  }

  lines.push(`\n## 允许引用的数字`);
  lines.push(f.allowedNumbers.join(", "));

  lines.push(`\n## 本次复盘的已知盲区`);
  for (const g of f.gaps) lines.push(`- ${g}`);

  return lines.join("\n");
}

/** Which refs exist, so a claim citing a typo is dropped rather than shown. */
function validRefs(refs: string[], f: ReviewFacts): string[] {
  const known = new Set(Object.keys(f.facts));
  const sec = f.sections as any;
  for (const [k, v] of Object.entries(sec)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const kk of Object.keys(v)) known.add(`${k}.${kk}`);
    }
    known.add(k);
  }
  known.add("position"); known.add("plan"); known.add("period"); known.add("totals");
  return refs.filter((r) => known.has(r));
}

function cleanClaims(items: unknown, f: ReviewFacts, where: string, issues: { code: string; detail: string }[]): ReviewClaim[] {
  const arr = Array.isArray(items) ? items : items ? [items] : [];
  const kept: ReviewClaim[] = [];
  for (const raw of arr) {
    if (!raw) continue;
    const text = String((raw as any).text ?? raw ?? "").trim();
    if (!text) continue;
    const refs = validRefs(
      (Array.isArray((raw as any).refs) ? (raw as any).refs : []).map(String),
      f,
    );
    const bad = numbersIn(text).filter((n) => !numberAllowed(n, f.allowedNumbers));
    if (bad.length) {
      issues.push({ code: "NUMBER_NOT_IN_EVIDENCE", detail: `${where}: 引用了未在事实中的数字 ${bad.slice(0, 4).join(", ")}` });
      continue;
    }
    if (!refs.length && text.length > 20) {
      issues.push({ code: "NO_REF", detail: `${where}: 判断缺少可验证引用` });
      continue;
    }
    kept.push({ text, refs });
  }
  return kept;
}

function validateReview(raw: unknown, f: ReviewFacts): { ok: boolean; report: ReviewReport | null; issues: { code: string; detail: string }[] } {
  const issues: { code: string; detail: string }[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, report: null, issues: [{ code: "NOT_OBJECT", detail: "模型未返回 JSON 对象" }] };
  }
  const o = raw as any;
  const verdict = ["good", "neutral", "bad", "mixed"].includes(o.verdict) ? o.verdict : null;
  if (!verdict) issues.push({ code: "BAD_VERDICT", detail: `无效 verdict: ${o.verdict}` });

  const headline = String(o.headline ?? "").trim();
  if (!headline) issues.push({ code: "NO_HEADLINE", detail: "缺少 headline" });
  else {
    const bad = numbersIn(headline).filter((n) => !numberAllowed(n, f.allowedNumbers));
    if (bad.length) issues.push({ code: "HEADLINE_NUMBER", detail: `标题含未在事实中的数字 ${bad.join(", ")}` });
  }

  const report: ReviewReport = {
    verdict: (verdict ?? "neutral") as ReviewReport["verdict"],
    headline,
    whatWorked: cleanClaims(o.whatWorked, f, "whatWorked", issues),
    whatDidnt: cleanClaims(o.whatDidnt, f, "whatDidnt", issues),
    costAnalysis: cleanClaims(o.costAnalysis, f, "costAnalysis", issues),
    lesson: cleanClaims(o.lesson, f, "lesson", issues),
    nextTime: cleanClaims(o.nextTime, f, "nextTime", issues),
    gaps: (Array.isArray(o.gaps) ? o.gaps : []).map(String).filter(Boolean),
  };

  // A review with no conclusion is worse than no review: the user cannot tell
  // "nothing to say" from "the model failed". require the spine.
  const fatal =
    !verdict || !headline ||
    report.costAnalysis.length === 0 ||
    report.lesson.length === 0 ||
    issues.some((i) => i.code === "HEADLINE_NUMBER");

  // Gaps are a safety surface, not model output to be curated. The facts layer
  // knows what the review cannot see; if the model omits or truncates that list,
  // the user silently loses the warning that matters most (e.g. "this profile is
  // built on 1.5 hours of data"). Union, never replace.
  const gapSet = new Set<string>([...f.gaps, ...report.gaps]);
  report.gaps = [...gapSet];

  return { ok: !fatal, report: fatal ? null : report, issues };
}

/* ─────────────────────────── entry point ─────────────────────────── */

async function callModel(f: ReviewFacts, skill: { text: string; version: string }, opts: any) {
  const system = `${skill.text}

---
# 当前任务

你是一名 LP 交易复盘员。基于下面的事实包，复盘这次交易。

${OUTPUT_CONTRACT}`;

  const user = renderFacts(f);

  return chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      json: true,
      temperature: 0.2,
      maxTokens: opts.maxTokens ?? 3000,
      timeoutMs: opts.timeoutMs ?? 120_000,
    },
  );
}

export async function review(
  scope: "position" | "period" | "style",
  subjectId: string,
  opts: { force?: boolean; ttlHours?: number; startMs?: number; endMs?: number } = {},
): Promise<ReviewResult> {
  const started = Date.now();

  // ---- facts (deterministic, never fails silently) ----
  let facts: ReviewFacts;
  if (scope === "position") {
    const f = buildPositionFacts(subjectId);
    if ("error" in f) {
      return {
        ok: false, scope, subjectId, subjectLabel: subjectId,
        facts: null as any, report: null, issues: [{ code: "NO_SUBJECT", detail: f.error }],
        degraded: true, degradeReason: f.error, cached: false, tookMs: Date.now() - started,
      };
    }
    facts = f;
  } else if (scope === "period") {
    const end = opts.endMs ?? Date.now();
    const start = opts.startMs ?? end - 7 * 86_400_000;
    facts = buildPeriodFacts(start, end);
  } else {
    const prof = deriveStyleProfile();
    facts = buildStyleFacts(prof);
    saveStyleProfile(prof, facts.sections);
  }

  const skill = loadSkill("defi-lp-review");
  const evidenceHash = sha(JSON.stringify(facts.facts) + JSON.stringify(facts.sections), 16);
  const cacheKey = `${scope}|${subjectId}|${evidenceHash}`;
  const ttl = (opts.ttlHours ?? 6) * 3600_000;

  if (!opts.force) {
    const hit = one<any>(
      `SELECT * FROM reviews WHERE kind=? AND subject_id=? AND status='ok' ORDER BY created_at DESC LIMIT 1`,
      scope, subjectId,
    );
    // A position keeps changing while open, so an old review of it is stale even
    // inside the TTL. Only reuse when the facts hash matches exactly.
    if (hit && Date.now() - Number(hit.created_at) < ttl && hit.evidence_version === evidenceHash) {
      return {
        ok: true, scope, subjectId, subjectLabel: facts.subjectLabel, facts,
        report: parseJson<ReviewReport | null>(hit.report, null),
        issues: [], degraded: false, cached: true,
        model: hit.model ?? undefined,
        tokensIn: hit.tokens_in ?? undefined,
        tokensOut: hit.tokens_out ?? undefined,
        tookMs: Date.now() - started, reviewId: hit.id,
      };
    }
  }

  // ---- model ----
  const llm = await callModel(facts, skill, opts);
  if (!llm.ok) {
    return {
      ok: false, scope, subjectId, subjectLabel: facts.subjectLabel, facts,
      report: null, issues: [{ code: "LLM", detail: llm.error ?? "unknown" }],
      degraded: true, degradeReason: `LLM: ${llm.error}`,
      cached: false, tookMs: Date.now() - started,
    };
  }

  let parsed: unknown = null;
  try { parsed = JSON.parse(llm.text); }
  catch {
    const m = llm.text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* stays null */ } }
  }

  const v = validateReview(parsed, facts);
  const id = "rv_" + sha(`${cacheKey}|${Date.now()}`, 16);

  run(
    `INSERT OR REPLACE INTO reviews
     (id,kind,subject_id,period_start,period_end,status,facts,report,model,tokens_in,tokens_out,
      created_at,evidence_version,skill_version,degrade_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, scope, subjectId,
    (facts.sections as any).period?.startMs ?? null,
    (facts.sections as any).period?.endMs ?? null,
    v.ok ? "ok" : "degraded",
    JSON.stringify(facts),
    v.report ? JSON.stringify(v.report) : null,
    llm.model, llm.tokensIn, llm.tokensOut, Date.now(),
    evidenceHash, skill.version,
    v.ok ? null : v.issues.map((i) => i.code).join(","),
  );

  return {
    ok: v.ok, scope, subjectId, subjectLabel: facts.subjectLabel, facts,
    report: v.report,
    issues: v.issues,
    degraded: !v.ok,
    degradeReason: !v.ok ? `报告未通过校验（${v.issues.map((i) => i.code).join(", ")}）` : undefined,
    cached: false,
    model: llm.model, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut,
    tookMs: Date.now() - started, reviewId: id,
  };
}

/** Turn the arithmetic profile into the same facts shape the other scopes use. */
export function buildStyleFacts(p: StyleProfile): ReviewFacts {
  const facts: Record<string, string | number | null> = {
    "结论可靠": p.reliable ? "是" : "否",
    "不可靠原因": p.reliable ? null : (p.unreliableReason ?? null),
    "观察窗口小时": p.observedSpanHours,
    "观察仓位": p.positionsObserved,
    "已平仓": p.closedObserved,
    "风险偏好": p.riskAppetite === 1 ? "保守" : p.riskAppetite === 3 ? "激进" : "平衡",
    "持有中位数小时": p.medianHoldHours,
    "平均每仓调仓": p.rebalanceFrequency,
    "胜率": p.winRate == null ? null : fmtPct(p.winRate, 1),
    "平均盈亏比": p.avgRealisedPnlPct == null ? null : fmtPct(p.avgRealisedPnlPct, 3),
    "偏好代币": p.preferSymbols.length ? p.preferSymbols.join(", ") : "暂无明显偏好",
    "回避代币": p.avoidSymbols.length ? p.avoidSymbols.join(", ") : "暂无明显回避",
  };

  const sections = {
    style: {
      reliable: p.reliable,
      unreliableReason: p.unreliableReason ?? null,
      observedSpanHours: p.observedSpanHours,
      riskAppetite: p.riskAppetite,
      preferSymbols: p.preferSymbols,
      avoidSymbols: p.avoidSymbols,
      medianHoldHours: p.medianHoldHours,
      rebalanceFrequency: p.rebalanceFrequency,
      winRate: p.winRate,
      avgRealisedPnlPct: p.avgRealisedPnlPct,
      positionsObserved: p.positionsObserved,
      closedObserved: p.closedObserved,
    },
  };

  const gaps: string[] = [];
  if (!p.reliable) gaps.push(`本次风格结论不可用于调整推荐：${p.unreliableReason}`);
  if (p.positionsObserved < 3) gaps.push(`只有 ${p.positionsObserved} 个仓位，样本不足以形成风格判断`);
  if (p.closedObserved === 0) gaps.push("没有已平仓记录，胜率与已实现收益无从计算");
  gaps.push("手续费收入未单独入账，收益构成只能从总盈亏推断");

  return {
    version: "review@1",
    scope: "style",
    subjectId: "global",
    subjectLabel: "交易风格总结",
    facts,
    allowedNumbers: dedupe(collectNumbers({ facts, sections })),
    sections,
    gaps,
    generatedAt: Date.now(),
  };
}

/**
 * Scoring knobs implied by the style profile.
 *
 * Returns nothing at all when the profile is unreliable. That is the whole point
 * of the reliability gate: a profile built from one afternoon of test trades
 * would otherwise silently re-rank every recommendation, and the user would have
 * no way to tell that the ordering came from three clicks of a test script.
 */
export function styleScoreOverrides(): {
  riskTier?: 1 | 2 | 3;
  preferSymbols?: string[];
  avoidSymbols?: string[];
  applied: boolean;
  reason?: string;
} {
  const saved = loadStyleProfile();
  if (!saved) return { applied: false, reason: "尚无风格档案" };
  if (!saved.profile.reliable) {
    return { applied: false, reason: saved.profile.unreliableReason ?? "风格结论不可靠" };
  }
  return {
    riskTier: saved.profile.riskAppetite,
    preferSymbols: saved.profile.preferSymbols,
    avoidSymbols: saved.profile.avoidSymbols,
    applied: true,
  };
}
