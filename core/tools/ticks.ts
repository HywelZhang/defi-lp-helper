/**
 * Uniswap V3 tick math.
 *
 * A percentage range is not enough to place a position: on-chain liquidity is
 * addressed by tick. onchainos' `defi calculate-entry` wants `--tick-lower` and
 * `--tick-upper`, so the plan must carry real ticks or the handoff is fake.
 *
 * The trap: ticks are priced in token1-per-token0, and token0/token1 are ordered
 * by ADDRESS, not by symbol. Getting that backwards silently inverts the range.
 * So we always resolve order from the two token addresses.
 *
 *   price = 1.0001^tick      →  tick = ln(price) / ln(1.0001)
 *
 * Ticks must be multiples of the pool's tick spacing, otherwise the router
 * rejects the position.
 */

export const TICK_SPACING: Record<string, number> = {
  "0.01": 1,
  "0.05": 10,
  "0.3": 60,
  "1": 200,
};

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export function tickSpacingFor(feeTierPct: number | null): number {
  if (feeTierPct === null) return 60;
  // fee tiers arrive as 0.01 / 0.05 / 0.3 / 1 (percent)
  const key = String(feeTierPct);
  if (TICK_SPACING[key] !== undefined) return TICK_SPACING[key];
  // tolerate 0.30 vs 0.3
  const normalized = String(Number(feeTierPct.toFixed(4)));
  return TICK_SPACING[normalized] ?? 60;
}

/** Round toward negative infinity to a multiple of spacing. */
export function alignTickDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

/** Round toward positive infinity to a multiple of spacing. */
export function alignTickUp(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

export function priceToTick(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.log(price) / Math.log(1.0001);
}

export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

/**
 * Convert a symmetric ±width range into aligned ticks.
 *
 * `priceToken1PerToken0` must already be oriented (see buildTickRange).
 */
export function rangeToTicks(
  priceToken1PerToken0: number,
  halfWidthPct: number,
  feeTierPct: number | null,
): {
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  priceLower: number;
  priceUpper: number;
  /** true when spacing forced the realised range wider than requested */
  widened: boolean;
} | null {
  const centerTick = priceToTick(priceToken1PerToken0);
  if (centerTick === null) return null;

  const spacing = tickSpacingFor(feeTierPct);
  const rawLower = centerTick + priceToTick(1 - halfWidthPct / 100)!;
  const rawUpper = centerTick + priceToTick(1 + halfWidthPct / 100)!;

  // Widen outward so the realised range never comes in narrower than requested;
  // a narrower range means more IL risk than the user agreed to.
  let tickLower = alignTickDown(rawLower, spacing);
  let tickUpper = alignTickUp(rawUpper, spacing);

  if (tickLower < MIN_TICK) tickLower = alignTickUp(MIN_TICK, spacing);
  if (tickUpper > MAX_TICK) tickUpper = alignTickDown(MAX_TICK, spacing);
  if (tickLower >= tickUpper) return null;

  const priceLower = tickToPrice(tickLower);
  const priceUpper = tickToPrice(tickUpper);
  const realizedHalfWidth = ((priceUpper - priceLower) / 2 / priceToken1PerToken0) * 100;
  const widened = realizedHalfWidth > halfWidthPct * 1.02;

  return { tickLower, tickUpper, tickSpacing: spacing, priceLower, priceUpper, widened };
}

/**
 * Resolve token order and orient the price.
 *
 * Uniswap orders by address: token0 < token1. Returns the multiplier that turns
 * "quote per base" into "token1 per token0".
 */
export function orientPrice(params: {
  baseAddress: string;
  quoteAddress: string;
  /** quote units per 1 base, as reported by the data source */
  priceQuotePerBase: number;
}): { token0IsBase: boolean; priceToken1PerToken0: number } | null {
  const a = params.baseAddress?.toLowerCase();
  const b = params.quoteAddress?.toLowerCase();
  if (!a || !b || !Number.isFinite(params.priceQuotePerBase) || params.priceQuotePerBase <= 0) return null;

  const token0IsBase = a < b;
  // base < quote  → token0=base, token1=quote → price(token1/token0) = quote per base
  // base > quote  → token0=quote, token1=base → price(token1/token0) = base per quote = 1/that
  const priceToken1PerToken0 = token0IsBase
    ? params.priceQuotePerBase
    : 1 / params.priceQuotePerBase;

  return { token0IsBase, priceToken1PerToken0 };
}
