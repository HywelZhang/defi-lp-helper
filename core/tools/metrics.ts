/**
 * Volatility and range math — deterministic, no LLM.
 *
 * The research report kept trying to cite "30d 波动" and "±10% 区间覆盖率".
 * Those numbers must exist in the evidence or the validator throws the claim
 * away, so they are computed here and injected into the bundle.
 */

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface VolStats {
  /** number of hourly points actually used */
  points: number;
  /** hours covered */
  windowHours: number;
  /** annualized realized volatility, percent */
  vol30dPct: number | null;
  vol7dPct: number | null;
  /** mean and std of hourly log returns */
  hourlyDrift: number | null;
  hourlyStd: number | null;
  /** price range over the window */
  minPrice: number | null;
  maxPrice: number | null;
  /** current price percentile within the window, 0-100 */
  pricePercentile: number | null;
  /** mean reversion hint: price vs window mean, percent */
  deviationFromMeanPct: number | null;
}

const HOURS_PER_YEAR = 24 * 365;

/** Std of log returns, annualized. Uses the last `hours` points. */
export function realizedVol(candles: Candle[], hours = 720): VolStats {
  const series = candles.slice(-hours);
  const empty: VolStats = {
    points: 0, windowHours: 0, vol30dPct: null, vol7dPct: null,
    hourlyDrift: null, hourlyStd: null, minPrice: null, maxPrice: null,
    pricePercentile: null, deviationFromMeanPct: null,
  };
  if (series.length < 24) return empty;

  const closes = series.map((c) => c.c).filter((x) => Number.isFinite(x) && x > 0);
  if (closes.length < 24) return empty;

  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const std = Math.sqrt(variance);

  const recent = rets.slice(-168); // ~7d
  const recentMean = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const recentVar = recent.reduce((a, b) => a + (b - recentMean) ** 2, 0) / Math.max(1, recent.length - 1);

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const last = closes[closes.length - 1];
  const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
  const below = closes.filter((x) => x <= last).length;

  return {
    points: series.length,
    windowHours: series.length,
    vol30dPct: round2(std * Math.sqrt(HOURS_PER_YEAR) * 100),
    vol7dPct: round2(Math.sqrt(recentVar) * Math.sqrt(HOURS_PER_YEAR) * 100),
    hourlyDrift: round4(mean),
    hourlyStd: round4(std),
    minPrice: round4(min),
    maxPrice: round4(max),
    pricePercentile: round2((below / closes.length) * 100),
    deviationFromMeanPct: round2(((last - avg) / avg) * 100),
  };
}

/**
 * Probability the price stays inside [downPct, upPct] over `days`, under a
 * driftless lognormal assumption. This is the honest caveat-free number:
 * GBM ignores jumps and fat tails, so it over-states the probability.
 */
export function rangeCoverageProb(volAnnualPct: number | null, downPct: number, upPct: number, days: number): number | null {
  if (volAnnualPct === null || volAnnualPct <= 0) return null;
  const sigma = (volAnnualPct / 100) * Math.sqrt(days / 365);
  if (sigma <= 0) return null;

  // P(min > L, max < U) for Brownian motion has a closed form via the
  // reflection principle; this is the standard approximation.
  const lnL = Math.log(1 - downPct / 100);
  const lnU = Math.log(1 + upPct / 100);
  const a = lnL / sigma;
  const b = lnU / sigma;

  const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  let p = 0;
  for (let k = -6; k <= 6; k++) {
    p += Phi(b - 2 * k * (b - a)) - Phi(a - 2 * k * (b - a));
  }
  return round2(Math.max(0, Math.min(1, p)) * 100);
}

/** Suggested range whose coverage is near `targetProb`, symmetric-ish. */
export function suggestRange(volAnnualPct: number | null, days: number, targetProb = 0.7): { downPct: number; upPct: number; coverage: number } | null {
  if (volAnnualPct === null || volAnnualPct <= 0) return null;
  for (let w = 2; w <= 60; w += 1) {
    const cov = rangeCoverageProb(volAnnualPct, w, w, days);
    if (cov !== null && cov >= targetProb * 100) return { downPct: w, upPct: w, coverage: cov };
  }
  const cov = rangeCoverageProb(volAnnualPct, 60, 60, days);
  return { downPct: 60, upPct: 60, coverage: cov ?? 0 };
}

/**
 * Impermanent loss for a v2-style constant product pool given a price ratio.
 * V3 concentrated positions amplify this; we report v2 as the lower bound and
 * label it as such rather than inventing a concentration multiplier.
 */
export function ilPct(priceRatio: number): number {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 0;
  const il = (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
  return round2(il * 100);
}

function round2(n: number) { return Math.round(n * 100) / 100; }
function round4(n: number) { return Math.round(n * 10000) / 10000; }

// Abramowitz & Stegun 7.1.26 — max error ~1.5e-7, plenty for a UI estimate
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
