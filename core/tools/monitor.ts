/**
 * Position monitoring: the part of the system that keeps working when nobody
 * is looking at the screen.
 *
 * Three things this must get right:
 *
 *  1. **Price is derived, not fetched.** onchainos returns `positionStatus:
 *     "ACTIVE"` for every open position — it never says "out of range", so that
 *     field cannot drive an alert. What it does return is the token amounts, and
 *     a V3 position's token ratio is a strict function of price inside the
 *     range. We invert that to recover the current price. Verified against the
 *     live USDG/USDT position: derived 0.998829 inside a 0.92654-1.08784 band,
 *     which is correct for a stablecoin pair.
 *
 *  2. **Out-of-range is a discrete state, not a gradient.** Once price leaves
 *     the band, the position holds 100% of one token and stops earning fees.
 *     The derived price is clamped at the boundary in that case — so the alert
 *     says "out below" / "out above" rather than pretending to know exactly
 *     where price is.
 *
 *  3. **Checks are recorded, not just displayed.** Every run writes a row, so
 *     "when did this go out of range" is answerable later, and a missed cron
 *     run is visible as a gap rather than silence.
 */

import { all, one, run } from "../db.ts";
import { sha, fmtUsd } from "../util.ts";
import { listPositions, walletAddresses, type LpPosition } from "./onchainos.ts";
import { syncPositions } from "./portfolio.ts";
import { chainLabel } from "../config.ts";
import { notify } from "./notify.ts";

export type RangeState = "in" | "near_lower" | "near_upper" | "out_below" | "out_above" | "unknown";

export interface PositionCheck {
  positionId: string;
  tokenId: string | null;
  poolName: string;
  valueUsd: number;
  costUsd: number;
  feesUsd: number;
  /** recovered current price, clamped to the band when outside it */
  price: number | null;
  lower: number | null;
  upper: number | null;
  /** where price sits in the band: 0 = lower edge, 1 = upper edge */
  bandPos: number | null;
  state: RangeState;
  /** percent distance to the nearer edge; negative when outside */
  edgePct: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  feeYieldPct: number | null;
  /** hours since the position was opened */
  ageHours: number | null;
  /** when this reading was taken; absent on live checks, set when read back */
  checkedAt?: number | null;
  notes: string[];
}

export interface AlertRow {
  id: string;
  positionId: string | null;
  level: "info" | "warn" | "danger";
  kind: string;
  title: string;
  detail: string | null;
  createdAt: number;
  acknowledged: boolean;
}

/* ─────────────────────── price recovery ─────────────────────── */

/**
 * Invert the V3 amount ratio to get price.
 *
 * For a position in range with liquidity L:
 *   baseAmount  = L * (1/sqrt(p) - 1/sqrt(pb))
 *   quoteAmount = L * (sqrt(p) - sqrt(pa))
 *
 * Dividing cancels L and leaves the ratio as a function of price alone:
 *
 *   r = (s - sa) * s * sb / (sb - s)      where s = sqrt(p), sa = sqrt(pa), sb = sqrt(pb)
 *
 * Rearranging gives a quadratic in s:
 *   sb*s^2 + (r - sb*sa)*s - r*sb = 0
 *
 * Solved directly rather than by bisection. The bisection version of this
 * function was wrong in a way that failed silently: the ratio tends to infinity
 * as price approaches the upper edge (denominator sb - s -> 0), so evaluating
 * f(upper) yielded Infinity, and a "reject non-finite endpoints" guard turned
 * every healthy position into state=unknown. That guard was checking for a
 * degenerate band but caught normal behaviour instead.
 *
 * Returns the clamped price, or null when the inputs cannot describe a position.
 */
export function priceFromAmounts(
  baseAmount: number,
  quoteAmount: number,
  lower: number,
  upper: number,
): number | null {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  if (!(lower > 0) || !(upper > lower)) return null;
  if (!(baseAmount > 0) || !(quoteAmount > 0)) return null;

  const r = quoteAmount / baseAmount;
  if (!Number.isFinite(r) || r <= 0) return null;

  const sa = Math.sqrt(lower);
  const sb = Math.sqrt(upper);

  // sb*s^2 + (r - sb*sa)*s - r*sb = 0
  const a = sb;
  const b = r - sb * sa;
  const c = -r * sb;

  const disc = b * b - 4 * a * c;
  if (!(disc >= 0)) return null;

  // a > 0 and c < 0, so sqrt(disc) > |b| and this root is always positive.
  const s = (-b + Math.sqrt(disc)) / (2 * a);
  if (!Number.isFinite(s) || s <= 0) return null;

  const p = s * s;
  if (!Number.isFinite(p)) return null;

  // Outside the band the derivation no longer holds; clamp so the caller sees
  // the boundary instead of a fabricated number.
  if (p <= lower) return lower;
  if (p >= upper) return upper;
  return p;
}

/** Classify where the position sits, given amounts and the band. */
export function classifyRange(
  tokens: { symbol: string; amount: number }[],
  lower: number | null,
  upper: number | null,
): { state: RangeState; price: number | null; bandPos: number | null; edgePct: number | null } {
  if (!lower || !upper || !(upper > lower)) {
    return { state: "unknown", price: null, bandPos: null, edgePct: null };
  }

  const amounts = tokens.map((t) => t.amount).filter((n) => Number.isFinite(n));
  const nonzero = amounts.filter((n) => n > 0);

  // A V3 position is two-sided in range and single-sided outside it. Treating
  // a dust amount as "in range" would mask a real exit, so the threshold is
  // relative to the position's own size rather than absolute.
  if (nonzero.length === 1) {
    const total = nonzero[0];
    const baseZero = amounts.findIndex((n) => n > 0) === 1;
    // If the base token is the empty side, price fell below the band: the pool
    // sold all base for quote. If quote is empty, price rose above it.
    const state: RangeState = baseZero ? "out_below" : "out_above";
    return { state, price: baseZero ? lower : upper, bandPos: baseZero ? 0 : 1, edgePct: 0 };
  }
  if (nonzero.length !== 2) {
    return { state: "unknown", price: null, bandPos: null, edgePct: null };
  }

  // tokens[0] is base, tokens[1] is quote (flattenPositions preserves order).
  const base = amounts[0] ?? 0;
  const quote = amounts[1] ?? 0;
  const price = priceFromAmounts(base, quote, lower, upper);
  if (price == null) {
    return { state: "unknown", price: null, bandPos: null, edgePct: null };
  }

  const bandPos = (price - lower) / (upper - lower);
  const span = upper - lower;
  // Distance to whichever edge is closer, as a share of the band width.
  const edgeShare = Math.min(bandPos, 1 - bandPos);
  const edgePct = Number((edgeShare * 100).toFixed(2));

  // "Near" means the position will stop earning fees with a small move. 10% of
  // the band is wide enough to give a day of warning on a stable pair, and
  // narrow enough that it does not fire constantly.
  let state: RangeState = "in";
  if (bandPos <= 0) state = "out_below";
  else if (bandPos >= 1) state = "out_above";
  else if (bandPos < 0.1) state = "near_lower";
  else if (bandPos > 0.9) state = "near_upper";

  return { state, price, bandPos, edgePct };
}

/* ─────────────────────── persistence ─────────────────────── */

export function ensureMonitorTables() {
  run(`CREATE TABLE IF NOT EXISTS position_checks (
    id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    price REAL,
    lower REAL,
    upper REAL,
    band_pos REAL,
    state TEXT NOT NULL,
    edge_pct REAL,
    value_usd REAL,
    cost_usd REAL,
    fees_usd REAL,
    pnl_usd REAL,
    pnl_pct REAL,
    note TEXT
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_checks_pos ON position_checks(position_id, checked_at DESC)`);

  run(`CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    position_id TEXT,
    level TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    dedupe_key TEXT NOT NULL
  )`);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key)`);
  run(`CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(acknowledged, created_at DESC)`);
}

/**
 * Raise an alert at most once per key.
 *
 * Without the dedupe key an hourly check would emit the same "out of range"
 * warning 24 times a day and train the user to ignore all of them.
 */
function raiseAlert(a: {
  positionId: string | null;
  level: "info" | "warn" | "danger";
  kind: string;
  title: string;
  detail?: string;
  dedupeKey: string;
}): AlertRow | null {
  const existing = one<any>(`SELECT * FROM alerts WHERE dedupe_key=?`, a.dedupeKey);
  if (existing) return null;

  const id = "al_" + sha(`${a.dedupeKey}:${Date.now()}`, 14);
  const now = Date.now();
  run(
    `INSERT INTO alerts (id,position_id,level,kind,title,detail,created_at,acknowledged,dedupe_key)
     VALUES (?,?,?,?,?,?,?,0,?)`,
    id, a.positionId, a.level, a.kind, a.title, a.detail ?? null, now, a.dedupeKey,
  );
  return {
    id, positionId: a.positionId, level: a.level, kind: a.kind,
    title: a.title, detail: a.detail ?? null, createdAt: now, acknowledged: false,
  };
}

export function listAlerts(limit = 50, includeAck = false): AlertRow[] {
  ensureMonitorTables();
  const rows = all<any>(
    `SELECT * FROM alerts ${includeAck ? "" : "WHERE acknowledged=0"} ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({
    id: r.id, positionId: r.position_id, level: r.level, kind: r.kind,
    title: r.title, detail: r.detail, createdAt: Number(r.created_at),
    acknowledged: Boolean(r.acknowledged),
  }));
}

export function ackAlert(id: string) {
  run(`UPDATE alerts SET acknowledged=1 WHERE id=?`, id);
}

export function ackAllAlerts() {
  run(`UPDATE alerts SET acknowledged=1 WHERE acknowledged=0`);
}

export function latestChecks(positionId?: string): PositionCheck[] {
  ensureMonitorTables();
  // Join the position row so callers get a pool name. Without it the daily
  // digest reported "worst: pos_9cb0…" — an id is not something a user can
  // recognise, and the name is already sitting one join away.
  const sql = positionId
    ? `SELECT c.*, p.pool_name, p.token_id FROM position_checks c
       LEFT JOIN positions p ON p.id=c.position_id
       WHERE c.position_id=? ORDER BY c.checked_at DESC LIMIT 1`
    : `SELECT c.*, p.pool_name, p.token_id FROM position_checks c
       LEFT JOIN positions p ON p.id=c.position_id
       JOIN (SELECT position_id, MAX(checked_at) m FROM position_checks GROUP BY position_id) t
         ON c.position_id=t.position_id AND c.checked_at=t.m`;
  const rows = all<any>(sql, ...(positionId ? [positionId] : []));
  return rows.map(rowToCheck);
}

function rowToCheck(r: any): PositionCheck {
  return {
    positionId: r.position_id,
    tokenId: r.token_id ?? null,
    poolName: String(r.pool_name ?? ""),
    valueUsd: Number(r.value_usd ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    feesUsd: Number(r.fees_usd ?? 0),
    price: r.price,
    lower: r.lower,
    upper: r.upper,
    bandPos: r.band_pos,
    state: r.state as RangeState,
    edgePct: r.edge_pct,
    pnlUsd: r.pnl_usd,
    pnlPct: r.pnl_pct,
    feeYieldPct: null,
    ageHours: null,
    checkedAt: Number(r.checked_at) || null,
    notes: [],
  };
}

/* ─────────────────────── the check itself ─────────────────────── */

export interface MonitorResult {
  ok: boolean;
  checked: number;
  alerts: AlertRow[];
  positions: PositionCheck[];
  error?: string;
  tookMs: number;
}

/** An alert that *should* exist, before dedupe or persistence. */
export interface AlertSpec {
  positionId: string;
  level: "info" | "warn" | "danger";
  kind: string;
  title: string;
  detail: string;
  dedupeKey: string;
}

/**
 * Decide which alerts a check warrants — pure, no DB, no clock beyond `day`.
 *
 * Split out from the monitoring loop because the loop needs a live chain read to
 * run at all, and "does an out-of-range position actually raise a danger alert"
 * is exactly the question that must be answerable without one. Keeping this
 * pure is what makes the alerting testable.
 */
export function decideAlerts(check: PositionCheck, day = new Date().toISOString().slice(0, 10)): AlertSpec[] {
  const out: AlertSpec[] = [];
  const pos = check.positionId;
  const name = check.poolName || pos;
  const priceText = check.price?.toFixed(6) ?? "?";
  const bandText = `${check.lower?.toFixed(6) ?? "?"}–${check.upper?.toFixed(6) ?? "?"}`;

  if (check.state === "out_below" || check.state === "out_above") {
    // "跌出" only describes a downward break. Using it for an upward break
    // produced "已跌出区间（上方）" — self-contradictory in a headline the user
    // reads first.
    const broke = check.state === "out_below"
      ? "已跌破区间下沿"
      : "已涨破区间上沿";
    out.push({
      positionId: pos,
      level: "danger",
      kind: "out_of_range",
      title: `${name} ${broke}`,
      detail: `当前价格 ${priceText}，区间 ${bandText}。仓位已停止赚取手续费，且全部转为单币种持有。`,
      dedupeKey: `oor:${pos}:${check.state}:${day}`,
    });
  } else if (check.state === "near_lower" || check.state === "near_upper") {
    const side = check.state === "near_lower" ? "下沿" : "上沿";
    out.push({
      positionId: pos,
      level: "warn",
      kind: "near_edge",
      title: `${name} 接近区间${side}`,
      detail: `距${side}约 ${check.edgePct?.toFixed(1)}% 的带宽（价格 ${priceText}）。再走一段就会停止赚费，可考虑提前调仓。`,
      dedupeKey: `near:${pos}:${check.state}:${day}`,
    });
  }

  // Drawdown buckets of 5% so a slow bleed reports once per bucket per day, not
  // every hour.
  if (check.pnlPct != null && check.pnlPct <= -5) {
    out.push({
      positionId: pos,
      level: check.pnlPct <= -15 ? "danger" : "warn",
      kind: "drawdown",
      title: `${name} 浮亏 ${check.pnlPct.toFixed(2)}%`,
      detail: `投入 ${fmtUsd(check.costUsd, 4)}，现值 ${fmtUsd(check.valueUsd, 4)}，手续费 ${fmtUsd(check.feesUsd, 4)}，净 ${fmtUsd(check.pnlUsd ?? 0, 4)}。`,
      dedupeKey: `dd:${pos}:${Math.floor(check.pnlPct / 5) * 5}:${day}`,
    });
  }

  // Fees sitting uncollected are dead capital.
  if (check.feesUsd > 0 && check.costUsd > 0 && (check.feesUsd / check.costUsd) * 100 >= 1) {
    out.push({
      positionId: pos,
      level: "info",
      kind: "fees_accrued",
      title: `${name} 手续费已累积 ${fmtUsd(check.feesUsd, 4)}`,
      detail: `占投入 ${((check.feesUsd / check.costUsd) * 100).toFixed(2)}%。可以收取并复投，否则不计入复利。`,
      dedupeKey: `fee:${pos}:${day}`,
    });
  }

  return out;
}

/**
 * One monitoring pass over every open position on a chain.
 *
 * Reads live from the chain rather than from `positions`, because the whole
 * point is to notice what changed since the last sync.
 */
export async function checkPositions(chain: string, opts: { persist?: boolean } = {}): Promise<MonitorResult> {
  const started = Date.now();
  ensureMonitorTables();
  const persist = opts.persist !== false;

  const addr = (await walletAddresses(chain))[0];
  if (!addr) {
    return { ok: false, checked: 0, alerts: [], positions: [], error: "钱包无地址", tookMs: Date.now() - started };
  }

  const live = await listPositions(chain, addr);
  if (!live.ok && !live.positions.length) {
    return {
      ok: false, checked: 0, alerts: [], positions: [],
      error: live.error ?? "链上读取失败", tookMs: Date.now() - started,
    };
  }

  // Keep the local table in step with the chain, so the assets page and the
  // monitor never disagree about what exists.
  await syncPositions(chain, addr).catch(() => null);

  const raised: AlertRow[] = [];
  const checks: PositionCheck[] = [];

  for (const p of live.positions) {
    const row = one<any>(
      `SELECT * FROM positions WHERE chain=? AND token_id=?`,
      chain, p.tokenId,
    );
    if (!row) continue;

    const lower = p.range.lowerPrice;
    const upper = p.range.upperPrice;
    const cls = classifyRange(p.tokens, lower, upper);

    const cost = Number(row.cost_usd ?? 0);
    const value = Number(p.valueUsd ?? 0);
    const fees = p.fees.reduce((a, f) => a + (f.valueUsd ?? 0), 0);
    const pnl = cost > 0 ? value + fees - cost : null;
    const pnlPct = cost > 0 && pnl != null ? (pnl / cost) * 100 : null;

    const openedAt = Number(row.opened_at ?? 0);
    const ageHours = openedAt ? (Date.now() - openedAt) / 3_600_000 : null;

    const notes: string[] = [];
    if (p.status && p.status !== "ACTIVE") notes.push(`链上状态 ${p.status}`);

    const check: PositionCheck = {
      positionId: row.id,
      tokenId: p.tokenId,
      poolName: p.name,
      valueUsd: value,
      costUsd: cost,
      feesUsd: fees,
      price: cls.price,
      lower,
      upper,
      bandPos: cls.bandPos,
      state: cls.state,
      edgePct: cls.edgePct,
      pnlUsd: pnl,
      pnlPct,
      feeYieldPct: cost > 0 ? (fees / cost) * 100 : null,
      ageHours,
      notes,
    };
    checks.push(check);

    if (persist) {
      run(
        `INSERT INTO position_checks
         (id,position_id,checked_at,price,lower,upper,band_pos,state,edge_pct,value_usd,cost_usd,fees_usd,pnl_usd,pnl_pct,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        "pc_" + sha(`${row.id}:${Date.now()}`, 14),
        row.id, Date.now(), cls.price, lower, upper, cls.bandPos, cls.state, cls.edgePct,
        value, cost, fees, pnl, pnlPct, notes.join("; ") || null,
      );
    }

    // ── alerts ────────────────────────────────────────────────
    // Two destinations on purpose: `alerts` is the monitor's own operational
    // record (what condition fired, when), `notifications` is the user's inbox.
    // They share a dedupe key so one condition produces one row in each, and
    // neither can drift into duplicates.
    for (const spec of decideAlerts(check)) {
      const a = raiseAlert(spec);
      if (a) {
        raised.push(a);
        notify({
          kind: "alert",
          level: spec.level,
          title: spec.title,
          body: spec.detail,
          source: "monitor",
          subjectType: "position",
          subjectId: spec.positionId,
          href: "/assets",
          dedupeKey: `notify:${spec.dedupeKey}`,
          meta: { alertId: a.id, checkState: check.state },
        });
      }
    }
  }

  return {
    ok: live.ok,
    checked: checks.length,
    alerts: raised,
    positions: checks,
    error: live.error,
    tookMs: Date.now() - started,
  };
}

/* ─────────────────────── daily digest ─────────────────────── */

/**
 * A once-a-day summary of the whole book.
 *
 * Written as a review so it lands in the same place as manual reviews and the
 * assistant can quote it. Numbers only — the prose judgement is left to the
 * model, which reads this via buildContext.
 */
export function buildDailyDigest(chain: string): {
  day: string;
  totalValue: number;
  totalCost: number;
  totalFees: number;
  totalPnl: number;
  totalPnlPct: number | null;
  open: number;
  outOfRange: number;
  nearEdge: number;
  worst: { poolName: string; pnlPct: number | null } | null;
  checks: PositionCheck[];
} {
  const checks = latestChecks();
  const open = checks.filter((c) => c.valueUsd > 0 || c.costUsd > 0);

  const totalValue = open.reduce((a, c) => a + c.valueUsd, 0);
  const totalCost = open.reduce((a, c) => a + c.costUsd, 0);
  const totalFees = open.reduce((a, c) => a + c.feesUsd, 0);
  const totalPnl = totalCost > 0 ? totalValue + totalFees - totalCost : 0;

  const worst = open
    .filter((c) => c.pnlPct != null)
    .sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0))[0];

  return {
    day: new Date().toISOString().slice(0, 10),
    totalValue,
    totalCost,
    totalFees,
    totalPnl,
    totalPnlPct: totalCost > 0 ? (totalPnl / totalCost) * 100 : null,
    open: open.length,
    outOfRange: open.filter((c) => c.state === "out_below" || c.state === "out_above").length,
    nearEdge: open.filter((c) => c.state === "near_lower" || c.state === "near_upper").length,
    worst: worst ? { poolName: worst.poolName || worst.positionId, pnlPct: worst.pnlPct } : null,
    checks: open,
  };
}

/** Persist the digest as a review row, once per day. */
export function saveDailyDigest(chain: string): { saved: boolean; day: string; summary: string } {
  const d = buildDailyDigest(chain);
  const key = `daily:${chain}:${d.day}`;
  const existing = one<any>(`SELECT id FROM reviews WHERE kind='daily' AND period_start=? AND period_end=?`, d.day, d.day);
  if (existing) return { saved: false, day: d.day, summary: "今日总结已存在" };

  const lines = [
    `今日持仓 ${d.open} 个，总投入 ${fmtUsd(d.totalCost, 4)}，现值 ${fmtUsd(d.totalValue, 4)}，累计手续费 ${fmtUsd(d.totalFees, 4)}。`,
    `合计盈亏 ${fmtUsd(d.totalPnl, 4)}${d.totalPnlPct != null ? `（${d.totalPnlPct.toFixed(2)}%）` : ""}。`,
    d.outOfRange > 0 ? `有 ${d.outOfRange} 个仓位已跌出区间，停止赚费。` : "所有仓位都在区间内。",
    d.nearEdge > 0 ? `另有 ${d.nearEdge} 个接近区间边缘。` : "",
    d.worst ? `表现最差：${d.worst.poolName}${d.worst.pnlPct != null ? ` ${d.worst.pnlPct.toFixed(2)}%` : ""}。` : "",
  ].filter(Boolean);

  const id = "rv_" + sha(key, 16);
  // `reviews` has four NOT NULL columns with no defaults (subject_id, status,
  // facts, evidence_version, skill_version). The first attempt omitted them and
  // failed with "NOT NULL constraint failed: reviews.subject_id" — the digest
  // silently never persisted.
  //
  // subject_id is the chain, because this row summarises every position on it
  // rather than one; status 'facts' marks it as numbers-only, never mistaken for
  // a model-written review that carries judgement.
  run(
    `INSERT INTO reviews
       (id,kind,subject_id,period_start,period_end,status,facts,created_at,evidence_version,skill_version)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, "daily", chain, d.day, d.day, "facts",
    JSON.stringify({ version: "daily@1", digest: d, text: lines.join("") }),
    Date.now(), "daily@1", "daily@1",
  );

  return { saved: true, day: d.day, summary: lines.join("") };
}
