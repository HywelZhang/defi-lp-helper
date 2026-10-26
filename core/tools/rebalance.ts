/**
 * Rebalance: move an existing V3 position into a different tick range.
 *
 * There is no atomic "rebalance" in the CLI — no `increase`/`decrease` exists.
 * A V3 position's range is fixed at mint time, so changing it necessarily
 * means: withdraw everything, then mint a new position at the new ticks.
 *
 * That two-step shape creates a real hazard we must design around: between the
 * withdraw and the rebuild the capital sits in the wallet as plain tokens. If
 * the rebuild fails, the user is left holding two stablecoins instead of a
 * position. So the intent (target range + the exact token amounts) is persisted
 * BEFORE the withdraw, which makes a failed rebuild resumable rather than a
 * silent loss of position.
 *
 * Phase state lives in positions.rebalance_json:
 *   { phase: "withdraw" | "rebuild", halfWidthPct, ticks, tokens, startedAt }
 */

import { one, run } from "../db.ts";
import { poolDetail } from "./pools.ts";
import { orientPrice, rangeToTicks } from "./ticks.ts";

export interface RebalanceIntent {
  /**
   * withdraw = capital released, rebuild not prepared yet
   * rebuild  = rebuild in flight (this is also the window during which the old
   *            NFT is gone from chain and the new one may appear)
   * done     = rebuild confirmed; stop adopting new NFTs for this row
   */
  phase: "withdraw" | "rebuild" | "done";
  halfWidthPct: number;
  ticks: {
    tickLower: number;
    tickUpper: number;
    spacing: number;
    priceLower: number;
    priceUpper: number;
    centerTick: number;
  };
  /** token amounts that will come back from the withdraw, in minimal units */
  tokens: { symbol: string; address: string; amount: string; decimals: number; amountHuman: string }[];
  startedAt: number;
  /** NFT id before the rebuild, so we can tell whether adoption happened */
  oldTokenId?: string | null;
  /** filled once the rebuild position exists */
  newPositionId?: string;
  withdrawTx?: string[];
}

export function readIntent(positionId: string): RebalanceIntent | null {
  const p = one<any>(`SELECT rebalance_json FROM positions WHERE id=?`, positionId);
  if (!p?.rebalance_json) return null;
  try {
    return JSON.parse(p.rebalance_json);
  } catch {
    return null;
  }
}

function writeIntent(positionId: string, intent: RebalanceIntent | null) {
  run(
    `UPDATE positions SET rebalance_json=? WHERE id=?`,
    intent ? JSON.stringify(intent) : null,
    positionId,
  );
}

/**
 * Work out where the new range should sit.
 *
 * Ticks are priced token1-per-token0 and token order comes from ADDRESS, not
 * symbol — the same trap that silently inverts a range at entry. Reuse the
 * entry-time helpers so a rebalance cannot disagree with how the position was
 * originally placed.
 */
export async function computeTargetTicks(params: {
  chain: string;
  poolAddress: string;
  halfWidthPct: number;
}): Promise<{ ok: boolean; error?: string; ticks?: RebalanceIntent["ticks"] }> {
  const d = await poolDetail(params.chain, params.poolAddress);
  if (!d.ok || !d.data) return { ok: false, error: "无法读取池子当前价格" };
  const pool: any = d.data;

  if (!pool.priceUsd || !pool.baseAddress || !pool.quoteAddress) {
    return { ok: false, error: "池子缺少价格或代币地址" };
  }

  const oriented = orientPrice({
    baseAddress: pool.baseAddress,
    quoteAddress: pool.quoteAddress,
    priceQuotePerBase: pool.priceUsd,
  });
  if (!oriented) return { ok: false, error: "无法确定代币顺序" };

  const tr = rangeToTicks(oriented.priceToken1PerToken0, params.halfWidthPct, pool.feeTierPct);
  if (!tr) return { ok: false, error: "区间计算失败（百分比过窄或价格异常）" };

  return {
    ok: true,
    ticks: {
      tickLower: tr.tickLower,
      tickUpper: tr.tickUpper,
      spacing: tr.tickSpacing,
      priceLower: tr.priceLower,
      priceUpper: tr.priceUpper,
      centerTick: Math.round(Math.log(oriented.priceToken1PerToken0) / Math.log(1.0001)),
    },
  };
}

/**
 * Record the intent and snapshot the capital that will be released.
 *
 * Uses the position's stored token amounts (refreshed by sync right before
 * this runs) rather than wallet balances: the wallet usually holds far more of
 * both tokens than the position does, so a balance reading would redeploy new
 * money instead of the position's own capital.
 */
export function beginRebalance(
  positionId: string,
  halfWidthPct: number,
  ticks: RebalanceIntent["ticks"],
  tokens: { symbol: string; address: string; amount: string; decimals: number; amountHuman: string }[],
): RebalanceIntent {
  const intent: RebalanceIntent = {
    phase: "withdraw",
    halfWidthPct,
    ticks,
    tokens,
    startedAt: Date.now(),
  };
  writeIntent(positionId, intent);
  return intent;
}

export function markWithdrawn(positionId: string, txHashes: string[]) {
  const intent = readIntent(positionId);
  if (!intent) return;
  intent.phase = "rebuild";
  intent.withdrawTx = txHashes;
  writeIntent(positionId, intent);
}

export function markRebuilt(positionId: string, newPositionId: string | null, merged = false) {
  const intent = readIntent(positionId);
  if (!intent) return;
  // Only close the window once the rebuild is actually reflected in our row.
  // The chain indexes the new NFT with a delay, so the immediate merge usually
  // finds nothing; marking `done` here anyway meant the later, successful
  // adoption never happened and the rebuild became a separate position.
  intent.phase = merged ? "done" : "rebuild";
  if (newPositionId) intent.newPositionId = newPositionId;
  writeIntent(positionId, intent);
}

export function clearIntent(positionId: string) {
  writeIntent(positionId, null);
}

/**
 * Turn a position's token amounts into `invest --token/--amount --token2/--amount2`.
 *
 * Both legs must be passed. Handing only one token makes the router swap an
 * unknown amount at whatever price it finds, which silently changes the cost
 * basis of the whole position.
 *
 * A small haircut keeps the call from reverting on rounding: the pool will
 * round each leg down, and asking for 100.000% of an exact balance reverts when
 * the last wei is already committed elsewhere.
 */
export function buildDualTokenArgs(tokens: RebalanceIntent["tokens"], haircutBps = 10): {
  ok: boolean;
  error?: string;
  token: string;
  amount: string;
  token2?: string;
  amount2?: string;
} {
  const usable = tokens.filter((t) => Number(t.amount) > 0);
  if (!usable.length) return { ok: false, error: "仓位没有可用代币", token: "", amount: "0" };

  const scale = (amt: string) => {
    const n = BigInt(amt);
    const after = (n * BigInt(10000 - haircutBps)) / 10000n;
    return after.toString();
  };

  const [a, b] = usable;
  if (!b) {
    // single-sided pool (or one leg rounded to zero): still valid, just one token
    return { ok: true, token: a.address, amount: scale(a.amount) };
  }
  return {
    ok: true,
    token: a.address,
    amount: scale(a.amount),
    token2: b.address,
    amount2: scale(b.amount),
  };
}
