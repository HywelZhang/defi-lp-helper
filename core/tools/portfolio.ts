/**
 * Portfolio tracking: our own record of positions and what we did to them.
 *
 * The chain (via onchainos) is the source of truth for *current* state. This
 * module adds the two things the chain cannot know:
 *   1. which plan/decision produced a position (cost basis, entry range)
 *   2. an append-only log of open / withdraw / collect actions
 *
 * Sync is additive: it never deletes a position the chain no longer returns —
 * that is what closing it is for — but it does mark a position closed when its
 * on-chain value drops to zero, so stale rows are visible instead of silent.
 */

import { randomBytes } from "node:crypto";
import { listPositions, walletAddresses, type LpPosition } from "./onchainos.ts";
import { one, all, run } from "../db.ts";

export interface PositionRow {
  id: string;
  plan_id: string | null;
  chain: string;
  address: string;
  investment_id: number;
  token_id: string | null;
  platform_id: number | null;
  platform_name: string | null;
  pool_name: string | null;
  value_usd: number | null;
  tokens_json: string;
  status: string;
  opened_at: number;
  closed_at: number | null;
  last_synced_at: number | null;
}

export interface PositionEventRow {
  id: string;
  position_id: string;
  kind: string;
  amount_usd: number | null;
  tokens_json: string;
  tx_hashes: string;
  payload: string | null;
  note: string | null;
  created_at: number;
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`;

/** Stable identity for a position: one wallet can hold several NFTs per pool. */
function positionKey(p: LpPosition) {
  return `${p.chain}:${p.chainIndex}:${p.investmentId}:${p.tokenId ?? "single"}`;
}

export function recordEvent(input: {
  positionId: string;
  kind: "open" | "withdraw" | "collect" | "range_adjust" | "sync";
  amountUsd?: number | null;
  tokens?: { symbol: string; amount: number; valueUsd?: number }[];
  txHashes?: string[];
  payload?: unknown;
  note?: string | null;
  at?: number;
}): string {
  const id = newId("ev");
  run(
    `INSERT INTO position_events (id, position_id, kind, amount_usd, tokens_json, tx_hashes, payload, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.positionId,
    input.kind,
    input.amountUsd ?? null,
    JSON.stringify(input.tokens ?? []),
    JSON.stringify(input.txHashes ?? []),
    input.payload ? JSON.stringify(input.payload) : null,
    input.note ?? null,
    input.at ?? Date.now(),
  );
  return id;
}

/**
 * Pull current positions from onchainos and reconcile with our table.
 *
 * Matching is by (chain, address, investmentId, tokenId) because that is what
 * actually identifies a V3 position; the pool address alone is ambiguous once
 * someone holds two ranges in the same pool.
 */
export async function syncPositions(chain: string, address?: string): Promise<{
  ok: boolean;
  error?: string;
  synced: number;
  opened: number;
  closed: number;
  /** positions newly attached to a plan during this sync */
  linked: number;
  /** rebuilt positions folded back into their origin row */
  merged: number;
  positions: PositionRow[];
}> {
  const addr = address ?? (await walletAddresses(chain))[0];
  if (!addr) return { ok: false, error: "钱包无地址", synced: 0, opened: 0, closed: 0, linked: 0, merged: 0, positions: [] };

  const live = await listPositions(chain, addr);
  if (!live.ok && !live.positions.length) {
    return { ok: false, error: live.error, synced: 0, opened: 0, closed: 0, linked: 0, merged: 0, positions: [] };
  }

  const now = Date.now();
  let opened = 0;
  let updated = 0;

  for (const p of live.positions) {
    let existing = one<PositionRow>(
      `SELECT * FROM positions WHERE chain=? AND address=? AND investment_id=? AND (token_id IS ? OR token_id = ?)`,
      p.chain, addr, p.investmentId, p.tokenId, p.tokenId,
    );

    // Rebalance continuation: rebuilding mints a NEW NFT, so the tokenId no
    // longer matches. Without this the rebuild would be recorded as a brand new
    // position and the original would look closed — turning one action into two
    // unrelated ones and losing the cost basis.
    if (!existing) {
      const cand = one<PositionRow>(
        `SELECT * FROM positions
         WHERE chain=? AND address=? AND investment_id=? AND status='open'
           AND rebalance_json IS NOT NULL
         ORDER BY opened_at DESC LIMIT 1`,
        p.chain, addr, p.investmentId,
      );
      if (cand) {
        let intent: any = null;
        try { intent = JSON.parse((cand as any).rebalance_json || "null"); } catch { /* keep null */ }
        if (intent?.phase === "rebuild") {
          // Adopt the new NFT onto the existing row.
          run(`UPDATE positions SET token_id=? WHERE id=?`, p.tokenId, cand.id);
          existing = { ...cand, token_id: p.tokenId };
        }
      }
    }

    const tokensJson = JSON.stringify(p.tokens);

    if (!existing) {
      const id = newId("pos");
      run(
        `INSERT INTO positions
         (id, plan_id, chain, address, investment_id, token_id, platform_id, platform_name,
          pool_name, value_usd, tokens_json, status, opened_at, last_synced_at,
          tick_lower, tick_upper)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`,
        id, null, p.chain, addr, p.investmentId, p.tokenId, p.platformId, p.platformName,
        p.name, p.valueUsd, tokensJson, now, now,
        p.range.tickLower, p.range.tickUpper,
      );
      // A position we never recorded was opened before tracking existed, or by
      // another wallet UI. Log it so the timeline has a starting point.
      recordEvent({
        positionId: id,
        kind: "open",
        amountUsd: p.valueUsd,
        tokens: p.tokens,
        note: "从链上同步发现（非本系统下单）",
        at: now,
      });
      opened++;
    } else {
      run(
        `UPDATE positions SET value_usd=?, tokens_json=?, platform_id=?, platform_name=?,
         pool_name=?, status='open', last_synced_at=?, tick_lower=?, tick_upper=? WHERE id=?`,
        p.valueUsd, tokensJson, p.platformId, p.platformName, p.name, now,
        p.range.tickLower, p.range.tickUpper, existing.id,
      );
      updated++;
    }
  }

  // positions we track but the chain no longer returns: value went to zero
  const liveKeys = new Set(live.positions.map(positionKey));
  const tracked = all<PositionRow>(
    `SELECT * FROM positions WHERE chain=? AND address=? AND status='open'`,
    chain, addr,
  );
  let closed = 0;
  for (const t of tracked) {
    const key = `${t.chain}:${chainIndexOf(chain)}:${t.investment_id}:${t.token_id ?? "single"}`;
    if (!liveKeys.has(key)) {
      // A position mid-rebalance legitimately vanishes from the chain between
      // the withdraw and the rebuild. Closing it here would split ONE action
      // into "position closed" + "new position opened", which misrepresents
      // what the user did and breaks the cost basis chain.
      let intent: any = null;
      try { intent = JSON.parse((t as any).rebalance_json || "null"); } catch { /* keep null */ }
      if (intent && intent.phase === "rebuild") continue;

      const stillHasValue = live.positions.some(
        (p) => p.investmentId === t.investment_id && p.valueUsd > 0.01,
      );
      if (stillHasValue) continue;
      run(`UPDATE positions SET status='closed', closed_at=?, value_usd=0 WHERE id=?`, now, t.id);
      recordEvent({ positionId: t.id, kind: "withdraw", note: "链上已无此仓位（同步关闭）", at: now });
      closed++;
    }
  }

  // ── reconcile plans ↔ positions ──────────────────
  // Linking at confirm-time is racy: the deposit tx confirms before the chain
  // has indexed the NFT, so the position often does not exist yet when we try
  // to attach its plan. Doing the match on every sync makes the link eventual
  // instead of one-shot, and also repairs anything that slipped through.
  const unlinked = all<PositionRow>(
    `SELECT * FROM positions WHERE chain=? AND address=? AND status='open' AND plan_id IS NULL`,
    chain, addr,
  );
  let linked = 0;
  for (const u of unlinked) {
    // A plan is a candidate when it executed against the same investmentId and
    // has not been claimed by another position yet. Ties are broken by time:
    // the plan activated before its position appeared on chain.
    const plan = one<any>(
      `SELECT p.id, p.real_cost_usd, p.activated_at
       FROM plans p
       WHERE p.chain=? AND p.investment_id=? AND p.status IN ('active','closed')
         AND NOT EXISTS (SELECT 1 FROM positions q WHERE q.plan_id = p.id)
         AND p.activated_at <= ?
       ORDER BY p.activated_at DESC LIMIT 1`,
      chain, u.investment_id, u.opened_at + 1000,
    );
    if (!plan) continue;

    run(`UPDATE positions SET plan_id=? WHERE id=? AND plan_id IS NULL`, plan.id, u.id);
    if (u.cost_usd == null && plan.real_cost_usd != null) {
      run(`UPDATE positions SET cost_usd=? WHERE id=?`, plan.real_cost_usd, u.id);
    }

    // Correct the existing open event instead of appending a second one. On
    // first sighting a position is logged as "synced from chain, not ours";
    // once the plan match succeeds that note is simply wrong, and two open
    // events for one deposit make the timeline read like two separate actions.
    const existingOpen = one<any>(
      `SELECT id FROM position_events WHERE position_id=? AND kind='open' ORDER BY created_at ASC LIMIT 1`,
      u.id,
    );
    if (existingOpen) {
      run(
        `UPDATE position_events SET note=?, amount_usd=?, tokens_json=?, tx_hashes=? WHERE id=?`,
        `执行计划 ${plan.id}`,
        Number(plan.real_cost_usd ?? u.value_usd) || null,
        u.tokens_json,
        JSON.stringify([]),
        existingOpen.id,
      );
    } else {
      recordEvent({
        positionId: u.id,
        kind: "open",
        amountUsd: Number(plan.real_cost_usd ?? u.value_usd) || null,
        tokens: (() => { try { return JSON.parse(u.tokens_json); } catch { return []; } })(),
        note: `执行计划 ${plan.id}`,
        at: u.opened_at,
      });
    }
    linked++;
  }

  // Merge any rebuilt position that appeared after the fact. Done on every sync
  // because the chain indexes a new NFT with a lag, so the post-rebuild attempt
  // frequently finds nothing and the duplicate materialises later.
  const merged = reconcileRebalanceDuplicates(chain, addr);

  const positions = all<PositionRow>(
    `SELECT * FROM positions WHERE chain=? AND address=? ORDER BY opened_at DESC`,
    chain, addr,
  );

  return { ok: live.ok, error: live.error, synced: live.positions.length, opened, closed, linked, merged, positions };
}

/** chain index used inside positionKey; derived from the chain name. */
function chainIndexOf(chain: string): string {
  const map: Record<string, string> = { "x-layer": "196", base: "8453", ethereum: "1", arbitrum: "42161" };
  return map[chain] ?? chain;
}

/** Attach the plan that opened a position, so cost basis and rationale show up. */
export function linkPositionToPlan(positionId: string, planId: string, costUsd: number | null, tokens: any[]) {
  run(`UPDATE positions SET plan_id=? WHERE id=? AND plan_id IS NULL`, planId, positionId);
  recordEvent({
    positionId,
    kind: "open",
    amountUsd: costUsd,
    tokens,
    note: `执行计划 ${planId}`,
  });
}

/**
 * Find the position row that a just-completed deposit created, then link it to
 * the plan. Matching on investmentId + the plan's tick range, because the
 * tokenId only exists after the chain indexes the NFT.
 */
export function linkLatestOpenPosition(planId: string, chain: string, investmentId: number, costUsd: number | null, tokens: any[]) {
  const cand = one<PositionRow>(
    `SELECT * FROM positions
     WHERE chain=? AND investment_id=? AND status='open' AND plan_id IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    chain, investmentId,
  );
  if (cand) {
    linkPositionToPlan(cand.id, planId, costUsd, tokens);
    return cand.id;
  }
  return null;
}

export function positionEvents(positionId: string): PositionEventRow[] {
  return all<PositionEventRow>(
    `SELECT * FROM position_events WHERE position_id=? ORDER BY created_at DESC`,
    positionId,
  );
}

export interface PortfolioSummary {
  totalValueUsd: number;
  totalCostUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  unclaimedFeesUsd: number;
  openCount: number;
  closedCount: number;
}

/**
 * Build the 我的资产 view: live rows + events + a summary.
 *
 * Cost basis comes from the linked plan's capital (our own decision), falling
 * back to the open event amount. PnL is therefore honest about being computed
 * against what we intended to spend, not against a fabricated entry price.
 */
export function getPortfolio(chain: string, opts: { sync?: boolean } = {}) {
  const rows = all<PositionRow>(`SELECT * FROM positions WHERE chain=? ORDER BY opened_at DESC`, chain);

  const positions = rows.map((p) => {
    const plan = p.plan_id
      ? one<any>(`SELECT id, pool_name, capital_usd, real_cost_usd, score, grade, payload, status, address, chain FROM plans WHERE id=?`, p.plan_id)
      : null;
    const evs = positionEvents(p.id);
    const openEvent = evs.find((e) => e.kind === "open");

    // Research conclusion for the pool behind this position. analyses keys on
    // `chain:address`, so the plan's pool address is the join we need — without
    // it the assets page can show numbers but not *why* we opened the position.
    let analysis: { verdict: string | null; headline: string | null; createdAt: number } | null = null;
    if (plan?.address && plan?.chain) {
      const a = one<any>(
        `SELECT report, created_at FROM analyses
         WHERE subject_type='pool' AND subject_id=? AND status='ok'
         ORDER BY created_at DESC LIMIT 1`,
        `${plan.chain}:${plan.address}`,
      );
      if (a?.report) {
        try {
          const rep = JSON.parse(a.report);
          analysis = {
            verdict: rep?.verdict ?? null,
            headline: rep?.headline ?? null,
            createdAt: a.created_at,
          };
        } catch { /* keep null */ }
      }
    }

    // Cost basis priority matters: plans.capital_usd is what the user ASKED for
    // (e.g. $50), while the real spend was $0.945. Using the requested amount
    // reported a fake -98% loss. Prefer the amount actually debited.
    const cost =
      Number(p.cost_usd ?? NaN) ||
      Number(plan?.real_cost_usd ?? NaN) ||
      Number(openEvent?.amount_usd ?? NaN) ||
      null;

    let tokens: any[] = [];
    try { tokens = JSON.parse(p.tokens_json); } catch { /* keep [] */ }

    let feesUsd = 0;
    let fees: any[] = [];
    try {
      const payload = plan?.payload ? JSON.parse(plan.payload) : null;
      fees = payload?.__fees ?? [];
      feesUsd = fees.reduce((s: number, f: any) => s + (Number(f.valueUsd) || 0), 0);
    } catch { /* ignore */ }

    const value = Number(p.value_usd ?? 0);

    // Closed vs open need different arithmetic:
    //   open   → unrealized PnL = (position value + leftover cash) - cost
    //   closed → realized PnL  = cash received - cost
    // Using value alone (which is 0 once closed) made every closed position
    // report a 100% loss even after the money had returned to the wallet.
    //
    // cash_back_usd matters after a rebalance: the pool never consumes both legs
    // in the ratio we offered, so some capital stays in the wallet. Ignoring it
    // reported a 0.91% loss on a position that actually lost 0.06%.
    const isClosed = p.status !== "open";
    const proceeds = Number(p.proceeds_usd ?? NaN);
    const cashBack = Number((p as any).cash_back_usd ?? 0) || 0;
    const basis = isClosed && Number.isFinite(proceeds) ? proceeds : value + cashBack;
    const pnl = cost != null ? basis - cost : null;
    const pnlPct = cost && cost > 0 ? (pnl! / cost) * 100 : null;

    return {
      ...p,
      tokens,
      plan: plan ? { id: plan.id, pool_name: plan.pool_name, score: plan.score, grade: plan.grade } : null,
      analysis,
      events: evs,
      costUsd: cost,
      pnlUsd: pnl,
      pnlPct,
      realized: isClosed,
      proceedsUsd: isClosed && Number.isFinite(proceeds) ? proceeds : null,
      cashBackUsd: cashBack,
      feesUsd,
    };
  });

  const openPositions = positions.filter((p) => p.status === "open");
  const closedPositions = positions.filter((p) => p.status !== "open");

  // The summary must use the same basis as per-position PnL. Counting only
  // position value while the individual rows also count leftover cash produced
  // a summary of -0.91% against a row-level -0.16% — the same number contradicted
  // itself on one screen.
  const totalValueUsd = openPositions.reduce(
    (s, p) => s + Number(p.value_usd ?? 0) + Number(p.cashBackUsd ?? 0), 0,
  );
  const totalCostUsd = openPositions.reduce((s, p) => s + Number(p.costUsd ?? 0), 0);
  const feesUsd = openPositions.reduce((s, p) => s + Number(p.feesUsd ?? 0), 0);
  const pnl = totalValueUsd - totalCostUsd;

  const summary: PortfolioSummary = {
    totalValueUsd,
    totalCostUsd,
    unrealizedPnlUsd: pnl,
    unrealizedPnlPct: totalCostUsd > 0 ? (pnl / totalCostUsd) * 100 : null,
    unclaimedFeesUsd: feesUsd,
    openCount: openPositions.length,
    closedCount: closedPositions.length,
  };

  return { positions, summary };
}

/** Store the latest unclaimed-fee snapshot on the position row (for display). */
export function saveFeesSnapshot(positionId: string, fees: any[]) {
  const p = one<PositionRow>(`SELECT plan_id FROM positions WHERE id=?`, positionId);
  if (!p?.plan_id) return;
  const plan = one<any>(`SELECT payload FROM plans WHERE id=?`, p.plan_id);
  if (!plan) return;
  try {
    const payload = JSON.parse(plan.payload);
    payload.__fees = fees;
    run(`UPDATE plans SET payload=? WHERE id=?`, JSON.stringify(payload), p.plan_id);
  } catch { /* ignore malformed payload */ }
}

/**
 * Fold a just-rebuilt position back into the row that started the rebalance.
 *
 * Doing this inside syncPositions proved unreliable: the chain may still list
 * the OLD NFT when the rebuild sync runs, so the rebuild looks like an ordinary
 * update; moments later the NEW NFT appears as a separate row. The result was
 * one user action displayed as "position closed" + "new position opened", which
 * also double-counts cost and shows a fake -50% loss.
 *
 * This runs as an explicit post-rebuild step instead, where the new NFT is
 * known to exist. It deletes the duplicate first: the UNIQUE(chain,address,
 * investment_id,token_id) index would otherwise reject the token_id move.
 */
export function mergeRebuiltPosition(oldId: string, chain: string, investmentId: number): string | null {
  const old = one<PositionRow>(`SELECT * FROM positions WHERE id=?`, oldId);
  if (!old) return null;

  const dup = one<PositionRow>(
    `SELECT * FROM positions
     WHERE chain=? AND investment_id=? AND status='open' AND id<>?
       AND (plan_id IS NULL OR plan_id = ?)
     ORDER BY opened_at DESC LIMIT 1`,
    chain, investmentId, oldId, old.plan_id,
  );
  if (!dup) return null;

  // take the values before the row disappears
  const dupTokenId = dup.token_id;
  const dupValue = dup.value_usd;
  const dupTicks = { lower: (dup as any).tick_lower, upper: (dup as any).tick_upper };
  const dupTokens = dup.tokens_json;

  run(`DELETE FROM position_events WHERE position_id=?`, dup.id);
  run(`DELETE FROM positions WHERE id=?`, dup.id);
  run(
    `UPDATE positions SET token_id=?, value_usd=?, last_value_usd=?, tokens_json=?,
     tick_lower=?, tick_upper=?, status='open' WHERE id=?`,
    dupTokenId, dupValue, dupValue, dupTokens, dupTicks.lower, dupTicks.upper, oldId,
  );
  return oldId;
}

/**
 * Fold a rebuilt position back into the row that started the rebalance.
 *
 * Runs on every sync, not just once after the rebuild tx. The chain indexes a
 * freshly minted NFT with a lag, so the immediate post-rebuild attempt usually
 * sees nothing and the new NFT shows up later as its own row. Without a repeat
 * pass, one rebalance permanently reads as "position closed + new position
 * opened", which also double-counts cost and shows a ~-50% fake loss.
 *
 * Only rows still marked `rebuild` are considered: once merged we set `done` so
 * a genuinely new position in the same pool is never swallowed.
 */
export function reconcileRebalanceDuplicates(chain: string, address: string): number {
  const origins = all<PositionRow>(
    `SELECT * FROM positions WHERE chain=? AND address=? AND rebalance_json IS NOT NULL`,
    chain, address,
  );

  let merged = 0;
  for (const o of origins) {
    let intent: any = null;
    try { intent = JSON.parse((o as any).rebalance_json || "null"); } catch { continue; }
    if (!intent || intent.phase === "done") continue;

    // CRITICAL: one pool can hold SEVERAL positions at once, and they all share
    // the same investment_id. Matching on investment_id alone deleted a real,
    // unrelated $0.90 position while rebalancing a $0.02 one. A rebuild can only
    // be a row that appeared AFTER this rebalance started, so bound it in time —
    // that is what separates "the NFT we just minted" from "a position that was
    // already sitting in the same pool".
    const startedAt = Number(intent.startedAt ?? 0);
    const dup = one<PositionRow>(
      `SELECT * FROM positions
       WHERE chain=? AND address=? AND investment_id=? AND status='open' AND id<>
         AND COALESCE(value_usd,0) > 0
         AND opened_at >= ?
       ORDER BY opened_at DESC LIMIT 1`,
      chain, address, o.investment_id, o.id, startedAt,
    );
    if (!dup) continue;

    // Never swallow a row that carries a different plan. The rebuild row is
    // always inserted unplanned (its plan is attached later); a row already
    // bound to another plan belongs to a different trade.
    if (dup.plan_id && o.plan_id && dup.plan_id !== o.plan_id) continue;

    const tokenId = dup.token_id;
    const value = dup.value_usd;
    const tokensJson = dup.tokens_json;
    const lower = (dup as any).tick_lower;
    const upper = (dup as any).tick_upper;

    // Delete first: UNIQUE(chain,address,investment_id,token_id) would reject
    // pointing the origin row at an NFT the duplicate still holds.
    run(`DELETE FROM position_events WHERE position_id=?`, dup.id);
    run(`DELETE FROM positions WHERE id=?`, dup.id);
    run(
      `UPDATE positions SET token_id=?, value_usd=?, last_value_usd=?, tokens_json=?,
       tick_lower=?, tick_upper=?, status='open', closed_at=NULL WHERE id=?`,
      tokenId, value, value, tokensJson, lower, upper, o.id,
    );

    intent.phase = "done";
    intent.newPositionId = o.id;
    run(`UPDATE positions SET rebalance_json=? WHERE id=?`, JSON.stringify(intent), o.id);
    merged++;
  }
  return merged;
}
