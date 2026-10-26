/**
 * plan.build — turn pool facts into an executable LP plan.
 *
 * Everything here is deterministic. No LLM. The numbers a user acts on must be
 * reproducible and testable, and a plan is exactly the kind of artifact where a
 * plausible-sounding invented number does real damage.
 *
 * Honest modelling decisions:
 *  - Fee income uses the pool's fee APR as an UPPER bound and then shows three
 *    capture scenarios. A concentrated position earns a larger share of fees
 *    per dollar than the pool average, but the share depends on tick
 *    distribution which we cannot see. So we show a range instead of inventing
 *    a single "concentration multiplier".
 *  - IL is the constant-product figure. V3 concentrated positions lose MORE
 *    than this near the edges, so IL here is a lower bound and the plan says so.
 *  - Gas is an explicit assumption (Base L2), not a measured cost.
 */

import { ResultBuilder } from "./result.ts";
import { poolDetail, tokenPools, tokenProfile } from "./pools.ts";
import { computeScore, type ScoreResult } from "./score.ts";
import { styleScoreOverrides } from "./review.ts";
import { realizedVol, suggestRange, rangeCoverageProb, ilPct, type Candle } from "./metrics.ts";
import { orientPrice, rangeToTicks, tickSpacingFor } from "./ticks.ts";
import { onchainosChain } from "../config.ts";
import { resolveInvestmentId, isInstalled as onchainosInstalled } from "./onchainos.ts";
import { fmtUsd, fmtPct, round, sha, truncate } from "../util.ts";
import { run, all, one } from "../db.ts";
import type { PoolRow } from "../types.ts";

const V = "plan.build@1";

/**
 * Smallest position worth opening.
 *
 * Derived from measurement, not taste: on this system a $0.94 position lost
 * 0.5-0.9% per rebalance while a $0.0195 one lost 2.71%. Slippage and pool-ratio
 * rounding are fixed costs, so they dominate as size falls. One dollar is the
 * point below which a single round trip can eat more than a week of fees.
 */
const MIN_POSITION_USD = 1;

export interface PlanOpts {
  capitalUsd?: number;
  riskTier?: 1 | 2 | 3;
  holdDays?: number;
  /** override the volatility-suggested half-width, in percent */
  rangeHalfWidthPct?: number;
  /** gas assumption per round trip (approve + mint + burn + collect) */
  gasUsd?: number;
  scoreOverride?: ScoreResult;
  /** standing automation to attach; omitted means no automation */
  automation?: Partial<AutomationPolicy>;
}

export interface Scenario {
  captureRate: number;
  label: string;
  feeUsd: number;
  netUsd: number;
  netPct: number;
}

export interface PlanPayload {
  version: string;
  pool: {
    chain: string;
    address: string;
    name: string;
    dex: string;
    baseSymbol: string;
    quoteSymbol: string;
    baseAddress: string;
    quoteAddress: string;
    feeTierPct: number | null;
    price: number | null;
    tvlUsd: number | null;
    vol24hUsd: number | null;
    feeAprPct: number | null;
  };
  capital: {
    requestedUsd: number;
    deployedUsd: number;
    maxByCapacityUsd: number;
    capped: boolean;
  };
  range: {
    halfWidthPct: number;
    lowerPrice: number | null;
    upperPrice: number | null;
    coverageProb: number | null;
    holdDays: number;
    source: "volatility" | "manual";
  };
  expectations: {
    feeAprUpperPct: number | null;
    scenarios: Scenario[];
    worstEdgeIlPct: number;
    worstEdgeIlUsd: number;
    breakevenDays: number | null;
    gasUsd: number;
    /** assumed slippage + rounding cost per round trip, in percent of capital */
    roundTripCostPct: number;
    roundTripCostUsd: number;
  };
  /** On-chain coordinates. Without ticks a "range" cannot be executed. */
  ticks: {
    token0IsBase: boolean;
    token0: string;
    token1: string;
    token0Symbol: string;
    token1Symbol: string;
    token0Decimals: number | null;
    token1Decimals: number | null;
    spacing: number;
    tickLower: number;
    tickUpper: number;
    /** price in token1 per token0 at the bounds */
    priceLower: number;
    priceUpper: number;
    centerTick: number;
    /** spacing forced a wider range than requested */
    widened: boolean;
  } | null;
  /** Exact command to hand to onchainos once funds are ready. */
  execution: {
    provider: "onchainos";
    /** ticks exist and the verdict allows execution */
    ready: boolean;
    note: string;
    command: string | null;
    /** onchainos actually lists this pool, so an order can be built */
    available: boolean;
    investmentId: number | null;
    unavailableReason?: string;
  };
  ilTable: { movePct: number; ilPct: number; ilUsd: number; netUsdBase: number }[];
  entry: { condition: string; rationale: string }[];
  exit: { condition: string; action: string }[];
  riskChecks: {
    id: string; label: string; pass: boolean; detail: string;
    /** block = must not trade; warn = trade allowed but flagged. Older payloads
     *  were written before this existed and are handled by executionBlockers(). */
    severity?: "block" | "warn";
  }[];
  verdict: "go" | "caution" | "no-go";
  summary: string;
  /**
   * Standing automation this position may be run under.
   *
   * Declared at plan time because "when should this position be re-centred" is
   * an investment decision, not an operational one — it belongs next to the
   * range, the target return and the exit conditions, where the user can see
   * what they are agreeing to.
   *
   * Off by default. A plan that silently starts moving real money because it
   * was created after the feature shipped would be the worst kind of surprise.
   */
  automation?: AutomationPolicy;
}

export interface AutomationPolicy {
  /** master switch for this position */
  enabled: boolean;
  /** recenter = keep price in the middle of the band */
  mode: "recenter" | "off";
  /**
   * Trigger: act once the price leaves the middle band of width ±tolerancePct
   * around the range centre. A tolerance of 0 would rebalance constantly on
   * noise; this is the deadband that makes the policy practical.
   */
  tolerancePct: number;
  /** how wide to rebuild the range, as a half-width percentage */
  halfWidthPct: number;
  /** never act more than this many times per position per day */
  maxPerDay: number;
  /** skip if the position is worth less than this (a $0.02 position costs more in attention than it earns) */
  minValueUsd: number;
  /** skip while the cost of the round trip exceeds this share of expected daily fees */
  maxCostToDailyFeeRatio: number;
  /** set when the user last changed this; the executor refuses older policies */
  updatedAt?: number;
}

export interface BuiltPlan {
  id: string;
  createdAt: number;
  payload: PlanPayload;
  score: ScoreResult;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function buildPlanPayload(
  pool: PoolRow & { series?: { t: number; c: number; v: number }[] },
  score: ScoreResult,
  opts: PlanOpts = {},
): PlanPayload {
  const holdDays = clamp(opts.holdDays ?? 14, 1, 180);
  // No silent floor. This used to read Math.max(50, capitalUsd), which did two
  // harmful things: the plan's expected fee/IL/net described a $50 position
  // while a $0.02 one was actually opened (2500x off), and it disagreed with the
  // capital passed to computeScore() in planBuild. Every dollar figure in one
  // plan must refer to the same position.
  const requested = Number.isFinite(opts.capitalUsd) && (opts.capitalUsd as number) > 0
    ? (opts.capitalUsd as number)
    : 2000;
  // Round-trip gas (approve + mint + burn + collect).
  //
  // Measured, not assumed: three real X Layer transactions through this wallet
  // (0x14615c77…, 0x6d1dbc5a…, 0xdd960f63…) all report serviceChargeUsd 0.00 and
  // 0 OKB consumed. The old default of $0.30 was two orders of magnitude wrong
  // and, once the size check below started using it, would have rejected every
  // plan — including profitable ones. Callers on other chains can override.
  const gasUsd = opts.gasUsd ?? 0;

  // capacity ceiling: entering/exiting more than 1/20 of TVL moves the price
  // enough that the slippage eats the fee income
  const maxByCapacity = Math.floor((pool.tvlUsd ?? 0) / 20);
  const deployed = Math.min(requested, maxByCapacity);
  const capped = deployed < requested;

  // --- range from realized volatility ---
  const candles: Candle[] = (pool.series ?? []).map((x: any) => ({
    t: x.t, o: x.o ?? x.c, h: x.h ?? x.c, l: x.l ?? x.c, c: x.c, v: x.v ?? 0,
  }));
  const vol = realizedVol(candles, 720);
  const suggested = suggestRange(vol.vol30dPct, holdDays, 0.7);

  const halfWidth = opts.rangeHalfWidthPct ?? suggested?.downPct ?? 10;
  const coverage = rangeCoverageProb(vol.vol30dPct, halfWidth, halfWidth, holdDays);
  const price = pool.priceUsd;

  const lower = price ? round(price * (1 - halfWidth / 100), 6) : null;
  const upper = price ? round(price * (1 + halfWidth / 100), 6) : null;

  // --- fee income scenarios ---
  const feeApr = pool.feeAprPct;
  const feeUpper = feeApr !== null ? (deployed * (feeApr / 100) * holdDays) / 365 : 0;

  // Round-trip cost that is NOT gas.
  //
  // Gas on X Layer is zero (measured), yet small positions still lost money —
  // 2.71% on a $0.0195 position, 0.5-0.9% on a $0.94 one. The cause is slippage
  // and the pool never consuming both legs in the offered ratio, both of which
  // are effectively fixed percentages. Modelling them as zero made every plan's
  // expected net look better than it can be.
  //
  // Rates come from our own rebalance measurements, interpolated by size. This
  // is an assumption and is labelled as one; it is not derived from pool data.
  const roundTripCostPct =
    deployed < 1 ? 3.0 :
    deployed < 10 ? 1.5 :
    deployed < 100 ? 0.8 :
    0.5;
  const roundTripCost = deployed * (roundTripCostPct / 100);

  // Small positions need finer precision: rounding $ elsewhere to cents turned
  // every sub-cent fee into 0, which made the profitability gate meaningless.
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

  // Capture rates are assumptions about how much of the pool-average fee APR a
  // concentrated position actually earns. Labeled, not hidden.
  const scenarios: Scenario[] = [0.4, 0.7, 1.0].map((rate, i) => {
    const fee = feeUpper * rate;
    const net = fee - gasUsd - roundTripCost;
    return {
      captureRate: rate,
      label: i === 0 ? "保守" : i === 1 ? "基准" : "乐观（上限）",
      feeUsd: r6(fee),
      netUsd: r6(net),
      netPct: deployed > 0 ? r6((net / deployed) * 100) : 0,
    };
  });

  // --- IL at the range edge (constant product, lower bound for V3) ---
  const ilEdgePct = Math.abs(ilPct(1 + halfWidth / 100));
  const ilEdgeUsd = round((deployed * ilEdgePct) / 100, 2) ?? 0;

  const baseDailyFee = (feeUpper * 0.7) / holdDays;
  const breakevenDays = baseDailyFee > 0 ? round(ilEdgeUsd / baseDailyFee, 1) : null;

  const ilTable = [-50, -30, -20, -10, -5, 0, 5, 10, 20, 30, 50].map((m) => {
    const pct = ilPct(1 + m / 100);
    const usd = round((deployed * Math.abs(pct)) / 100, 2) ?? 0;
    return {
      movePct: m,
      ilPct: round(pct, 2) ?? 0,
      ilUsd: usd,
      netUsdBase: round((scenarios[1].feeUsd - usd - gasUsd), 2) ?? 0,
    };
  });

  // --- entry / exit rules (data-driven, not vibes) ---
  const entry: { condition: string; rationale: string }[] = [];
  const pctile = vol.pricePercentile;
  if (pctile !== null && pctile < 15) {
    entry.push({
      condition: `分三批建仓，首批 1/3，价格每下移 5% 加一批`,
      rationale: `当前价处于 30d 区间 ${pctile.toFixed(1)}% 分位（低位），一次性建仓容易买在下跌中继`,
    });
  } else if (pctile !== null && pctile > 85) {
    entry.push({
      condition: `等待价格回落至 30d 中位数附近再建仓`,
      rationale: `当前价处于 30d 区间 ${pctile.toFixed(1)}% 分位（高位），此时进区间易被向下穿越`,
    });
  } else {
    entry.push({
      condition: `按计划一次性建仓，区间 ±${halfWidth}%`,
      rationale: `当前价处于 30d 区间 ${pctile?.toFixed(1) ?? "?"}% 分位（中部），无明显择时优势`,
    });
  }

  if (vol.vol7dPct !== null && vol.vol30dPct !== null && vol.vol7dPct > vol.vol30dPct * 1.4) {
    entry.push({
      condition: `首笔仓位减半（7d 波动 ${vol.vol7dPct.toFixed(1)}% 显著高于 30d ${vol.vol30dPct.toFixed(1)}%）`,
      rationale: `短期波动放大，区间被穿越的概率高于历史均值`,
    });
  }

  const exit = [
    { condition: `价格越界 ±${halfWidth}% 持续 4 小时`, action: "撤出流动性，重新评估区间再入场" },
    { condition: `7d fee APR 跌破 5% 且持仓超过 7 天`, action: "退出，资金转向更高收益标的" },
    { condition: `池子 TVL 1 小时内下跌超过 30%`, action: "立即撤出（流动性撤离信号）" },
    { condition: `净损益（含费用）低于 -${Math.max(6, Math.round(ilEdgePct))}%`, action: "止损退出，不论是否还在区间内" },
    { condition: `稳定币对脱锚超过 1%`, action: "立即退出，不等待回归" },
  ];

  // --- risk checks ---
  //
  // Each check carries a severity. This matters more than it looks: before, ANY
  // failed check merely downgraded the verdict to "caution", and execute.ts only
  // refused "no-go" — so a 53-point D-grade plan with negative expected return
  // sailed through to a real transaction. A gate that cannot stop a trade is not
  // a gate, it is a label.
  const baseNet = scenarios[1].netUsd;

  const riskChecks: {
    id: string; label: string; pass: boolean; detail: string; severity: "block" | "warn";
  }[] = [
    {
      id: "score",
      label: "评分门槛",
      // Speculative money needs a reason to exist. D and F are below the line
      // where the pool pays for the risk taken.
      pass: score.grade !== "F" && score.grade !== "D" && score.total >= 55,
      detail: `${score.total} 分 / ${score.grade}（要求 C 及以上）`,
      severity: "block",
    },
    {
      id: "net_positive",
      label: "预期净收益",
      // The whole point of the position is to end up with more than it started
      // with. If the base case already loses money, the trade is a donation.
      pass: baseNet > 0,
      detail: `基准情形净 ${fmtUsd(baseNet)}（要求 > 0，已含往返 gas ${fmtUsd(gasUsd)}）`,
      severity: "block",
    },
    {
      id: "capacity",
      label: "容量约束",
      pass: !capped,
      detail: capped ? `TVL 上限 ${fmtUsd(maxByCapacity)}，本金已被压缩` : `${(maxByCapacity / Math.max(1, deployed)).toFixed(0)}x 容量`,
      severity: "block",
    },
    {
      id: "size",
      label: "最小可执行规模",
      // Not a gas check — gas here is zero. What actually eats small positions is
      // slippage and pool-ratio rounding, which do not shrink with size. Measured
      // on this system: a $0.94 position lost 0.5-0.9% per rebalance, a $0.0195
      // position lost 2.71%. Below roughly a dollar the cost swamps the yield.
      pass: deployed >= MIN_POSITION_USD,
      detail: `本金 ${fmtUsd(deployed)}（下限 ${fmtUsd(MIN_POSITION_USD)}；实测 $0.02 仓位调一次亏 2.71%）`,
      severity: "block",
    },
    {
      id: "coverage",
      label: "区间覆盖",
      pass: (coverage ?? 0) >= 55,
      detail: `±${halfWidth}% 覆盖 ${holdDays} 天概率 ${coverage ?? "?"}%`,
      severity: "warn",
    },
    {
      id: "il_vs_fee",
      label: "费用能否覆盖边界 IL",
      pass: breakevenDays !== null && breakevenDays <= holdDays,
      detail: breakevenDays === null ? "无法计算" : `需 ${breakevenDays} 天，持有期 ${holdDays} 天`,
      severity: "warn",
    },
    {
      id: "vol",
      label: "波动可控",
      pass: (vol.vol30dPct ?? 0) < 120,
      detail: `30d 年化波动 ${vol.vol30dPct ?? "?"}%`,
      severity: "block",
    },
  ];

  const failed = riskChecks.filter((r) => !r.pass);
  const blockedChecks = failed.filter((r) => r.severity === "block");
  const warnedChecks = failed.filter((r) => r.severity === "warn");

  const hardFail = score.gates.some((g) => g.blocked && g.severity === "block") || score.grade === "F";
  const verdict: PlanPayload["verdict"] =
    hardFail || blockedChecks.length > 0
      ? "no-go"
      : warnedChecks.length > 0
        ? "caution"
        : "go";

  const blockingLabels = [
    ...(hardFail ? [score.grade === "F" ? "评分 F" : "硬门槛未通过"] : []),
    ...blockedChecks.map((c) => c.label),
  ];
  const summary =
    verdict === "no-go"
      ? `不建议执行：${blockingLabels.join("、") || "未通过硬性检查"}`
      : `投入 ${fmtUsd(deployed)}，区间 ±${halfWidth}%（覆盖 ${coverage ?? "?"}%），持有 ${holdDays} 天；` +
        `基准情形费用 ${fmtUsd(scenarios[1].feeUsd)}，边界 IL ${fmtUsd(ilEdgeUsd)}，净 ${fmtUsd(scenarios[1].netUsd)}`;

  // --- on-chain coordinates ---
  // A percentage range cannot be executed. Resolve token order from addresses
  // (not symbols) and align to the pool's tick spacing, or the position lands
  // inverted or gets rejected by the router.
  const oriented = orientPrice({
    baseAddress: pool.baseAddress,
    quoteAddress: pool.quoteAddress,
    priceQuotePerBase: pool.priceUsd ?? 0,
  });

  let ticks: PlanPayload["ticks"] = null;
  if (oriented && pool.priceUsd) {
    const tr = rangeToTicks(oriented.priceToken1PerToken0, halfWidth, pool.feeTierPct);
    if (tr) {
      const token0 = oriented.token0IsBase ? pool.baseAddress : pool.quoteAddress;
      const token1 = oriented.token0IsBase ? pool.quoteAddress : pool.baseAddress;
      ticks = {
        token0IsBase: oriented.token0IsBase,
        token0,
        token1,
        token0Symbol: oriented.token0IsBase ? pool.baseSymbol : pool.quoteSymbol,
        token1Symbol: oriented.token0IsBase ? pool.quoteSymbol : pool.baseSymbol,
        token0Decimals: null,
        token1Decimals: null,
        spacing: tr.tickSpacing,
        tickLower: tr.tickLower,
        tickUpper: tr.tickUpper,
        priceLower: round(tr.priceLower, 8) ?? tr.priceLower,
        priceUpper: round(tr.priceUpper, 8) ?? tr.priceUpper,
        centerTick: Math.round(Math.log(oriented.priceToken1PerToken0) / Math.log(1.0001)),
        widened: tr.widened,
      };
    }
  }

  const execution: PlanPayload["execution"] = {
    provider: "onchainos",
    ready: Boolean(ticks) && verdict !== "no-go",
    available: false,
    investmentId: null,
    note: ticks
      ? "参数已就绪，可在下方直接下单（onchainos 代扣签名，会真实动用资金）"
      : "缺少 tick 坐标，无法构造链上交易",
    command: ticks
      ? `onchainos defi invest --investment-id <投资ID> --chain ${onchainosChain(pool.chain)} ` +
        `--address <钱包地址> --token ${pool.quoteAddress} --amount <最小单位> ` +
        `--tick-lower ${ticks.tickLower} --tick-upper ${ticks.tickUpper}`
      : null,
  };

  return {
    version: V,
    pool: {
      chain: pool.chain,
      address: pool.address,
      name: pool.name,
      dex: pool.dex,
      baseSymbol: pool.baseSymbol,
      quoteSymbol: pool.quoteSymbol,
      baseAddress: pool.baseAddress,
      quoteAddress: pool.quoteAddress,
      feeTierPct: pool.feeTierPct,
      price: pool.priceUsd,
      tvlUsd: pool.tvlUsd,
      vol24hUsd: pool.vol24hUsd,
      feeAprPct: feeApr !== null ? round(feeApr, 2) : null,
    },
    capital: {
      requestedUsd: requested,
      deployedUsd: deployed,
      maxByCapacityUsd: maxByCapacity,
      capped,
    },
    range: {
      halfWidthPct: halfWidth,
      lowerPrice: lower,
      upperPrice: upper,
      coverageProb: coverage,
      holdDays,
      source: opts.rangeHalfWidthPct ? "manual" : "volatility",
    },
    expectations: {
      feeAprUpperPct: feeApr !== null ? round(feeApr, 2) : null,
      scenarios,
      worstEdgeIlPct: round(ilEdgePct, 2) ?? 0,
      worstEdgeIlUsd: ilEdgeUsd,
      breakevenDays,
      gasUsd,
      roundTripCostPct,
      roundTripCostUsd: r6(roundTripCost),
    },
    ilTable,
    ticks,
    execution,
    entry,
    exit,
    riskChecks,
    verdict,
    summary,
    automation: resolvePolicy(opts.automation),
  };
}

/**
 * Normalise an automation policy, defaulting to disabled.
 *
 * Every field is clamped rather than rejected: a plan with a nonsense tolerance
 * should still be saveable, just not automatable. Silent rejection would leave
 * the user believing automation was on.
 */
export function resolvePolicy(input?: Partial<AutomationPolicy>): AutomationPolicy {
  const p: AutomationPolicy = {
    enabled: input?.enabled === true,
    mode: input?.mode === "recenter" ? "recenter" : "off",
    tolerancePct: clamp(Number(input?.tolerancePct ?? 12), 1, 45),
    halfWidthPct: clamp(Number(input?.halfWidthPct ?? 10), 1, 50),
    maxPerDay: Math.round(clamp(Number(input?.maxPerDay ?? 2), 1, 10)),
    minValueUsd: clamp(Number(input?.minValueUsd ?? 20), 0, 1e9),
    maxCostToDailyFeeRatio: clamp(Number(input?.maxCostToDailyFeeRatio ?? 0.5), 0.01, 10),
    updatedAt: Date.now(),
  };
  // An enabled policy with mode "off" is contradictory; the switch is the
  // master, so honouring `enabled` and silently doing nothing would be a trap.
  if (p.enabled && p.mode === "off") p.mode = "recenter";
  if (!p.enabled) p.mode = "off";
  return p;
}

export async function planBuild(
  chain: string,
  address: string,
  opts: PlanOpts & { save?: boolean } = {},
) {
  const b = new ResultBuilder(V);

  const detail = await poolDetail(chain, address);
  if (!detail.ok || !detail.data) return b.degrade(detail.degradedReason ?? "pool unavailable").fail("plan.build failed");

  const pool = detail.data as any;
  // Style only nudges the score when the profile is trustworthy; otherwise the
  // plan is scored on the pool alone, exactly as before.
  const style = styleScoreOverrides();
  const score = opts.scoreOverride ?? computeScore(pool, {
    capitalUsd: opts.capitalUsd ?? 2000,
    riskTier: opts.riskTier ?? style.riskTier ?? 2,
    preferSymbols: style.preferSymbols,
    avoidSymbols: style.avoidSymbols,
  });

  const payload = buildPlanPayload(pool, score, opts);
  const id = sha(`plan:${chain}:${address}:${Date.now()}`, 20);
  const createdAt = Date.now();

  // Resolve the onchainos investment id at build time, not at click time.
  // Finding out "this pool cannot be traded" only when the user presses
  // 预览下单 is a bad surprise: they may have already decided to allocate.
  if (onchainosInstalled() && payload.ticks) {
    try {
      const res = await resolveInvestmentId({
        chain,
        baseSymbol: pool.baseSymbol,
        quoteSymbol: pool.quoteSymbol,
        feeTierPct: pool.feeTierPct,
        tvlUsd: pool.tvlUsd,
      });
      payload.execution.available = res.ok;
      payload.execution.investmentId = res.investmentId ?? null;
      if (!res.ok) {
        payload.execution.unavailableReason = res.error ?? "onchainos 未收录";
        payload.execution.ready = false;
        payload.execution.note = `参数已生成，但${res.error ?? "onchainos 未收录该池子"} — 无法通过 onchainos 下单`;
      } else {
        payload.execution.note = "参数已就绪，可在下方直接下单（onchainos 代扣签名，会真实动用资金）";
      }
    } catch (e: any) {
      payload.execution.available = false;
      payload.execution.unavailableReason = String(e?.message ?? e);
      payload.execution.ready = false;
    }
  }

  b.source("GeckoTerminal", pool.url);
  b.fact("plan.capital", "投入本金", payload.capital.deployedUsd, { unit: "USD" });
  b.fact("plan.range", "区间", `±${payload.range.halfWidthPct}%`, { unit: "%" });
  b.fact("plan.coverage", "区间覆盖概率", payload.range.coverageProb, { unit: "%", approx: true });
  b.fact("plan.feeBase", "基准费用收入", payload.expectations.scenarios[1].feeUsd, { unit: "USD", approx: true });
  b.fact("plan.ilEdge", "边界 IL", payload.expectations.worstEdgeIlUsd, { unit: "USD", approx: true });
  b.fact("plan.netBase", "基准净收益", payload.expectations.scenarios[1].netUsd, { unit: "USD", approx: true });
  b.fact("plan.breakeven", "费用覆盖 IL 所需天数", payload.expectations.breakevenDays, { unit: "days" });
  b.fact("plan.verdict", "结论", payload.verdict);
  b.fact("plan.score", "池子评分", `${score.total}/${score.grade}`);
  b.fact("plan.tradable", "可下单", payload.execution.available ? "是" : "否");

  if (opts.save) {
    run(
      `INSERT INTO plans
       (id,created_at,chain,address,pool_name,capital_usd,range_down_pct,range_up_pct,entry_price,
        lower_price,upper_price,hold_days,expected_fee_usd,expected_il_usd,net_usd,breakeven_days,
        score,grade,risk_tier,payload,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`,
      id, createdAt, chain, address, pool.name, payload.capital.deployedUsd,
      payload.range.halfWidthPct, payload.range.halfWidthPct, payload.pool.price,
      payload.range.lowerPrice, payload.range.upperPrice, payload.range.holdDays,
      payload.expectations.scenarios[1].feeUsd, payload.expectations.worstEdgeIlUsd,
      payload.expectations.scenarios[1].netUsd, payload.expectations.breakevenDays,
      score.total, score.grade, opts.riskTier ?? 2, JSON.stringify(payload),
    );
    b.fact("plan.saved", "计划已保存", id);
  }

  return b.ok({
    id: opts.save ? id : null,
    createdAt,
    payload,
    score,
  });
}

export function planList(limit = 20) {
  return all<any>(
    `SELECT id,created_at,chain,address,pool_name,capital_usd,range_down_pct,range_up_pct,
            entry_price,lower_price,upper_price,hold_days,expected_fee_usd,expected_il_usd,
            net_usd,breakeven_days,score,grade,status
     FROM plans ORDER BY created_at DESC LIMIT ?`,
    limit,
  ).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    chain: r.chain,
    address: r.address,
    poolName: r.pool_name,
    capitalUsd: r.capital_usd,
    rangePct: r.range_down_pct,
    entryPrice: r.entry_price,
    lowerPrice: r.lower_price,
    upperPrice: r.upper_price,
    holdDays: r.hold_days,
    expectedFeeUsd: r.expected_fee_usd,
    expectedIlUsd: r.expected_il_usd,
    netUsd: r.net_usd,
    breakevenDays: r.breakeven_days,
    score: r.score,
    grade: r.grade,
    status: r.status,
  }));
}

export function planGet(id: string) {
  const r = one<any>(`SELECT * FROM plans WHERE id = ?`, id);
  if (!r) return null;
  return {
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    chain: r.chain,
    address: r.address,
    payload: JSON.parse(r.payload),
  };
}

export function planSetStatus(id: string, status: "draft" | "active" | "closed" | "cancelled") {
  run(`UPDATE plans SET status = ? WHERE id = ?`, status, id);
  return planGet(id);
}

/**
 * Why this plan must not be executed, if anything.
 *
 * Kept here (not in execute.ts) so the rule lives beside the checks that produce
 * it, and so both the API and the UI can explain the refusal with the same words.
 *
 * Legacy payloads matter: plans created before risk checks carried a severity
 * have no `block` markers at all. Falling back to "no markers means fine" would
 * let exactly the plans we just learned to reject (D grade, negative expected
 * return) walk straight through, so those are re-judged from the numbers that
 * were stored at the time.
 */
export function executionBlockers(payload: any): string[] {
  if (!payload) return ["计划内容缺失"];

  const out: string[] = [];
  if (payload.verdict === "no-go") out.push("计划结论为不建议执行");

  const checks: any[] = Array.isArray(payload.riskChecks) ? payload.riskChecks : [];
  const hasSeverity = checks.some((c) => c.severity === "block" || c.severity === "warn");

  if (hasSeverity) {
    for (const c of checks) {
      if (!c.pass && c.severity === "block") out.push(`${c.label}（${c.detail}）`);
    }
    return [...new Set(out)];
  }

  // ---- legacy plan: re-judge from stored numbers ----
  const score = checks.find((c) => c.id === "score");
  if (score && !score.pass) out.push(`评分门槛（${score.detail}）`);

  const scenarios: any[] = payload.expectations?.scenarios ?? [];
  const base = scenarios.find((x) => x.label === "基准") ?? scenarios[1];
  if (base && Number(base.netUsd) <= 0) {
    out.push(`预期净收益为负（基准 ${base.netUsd} USD）`);
  }

  // A legacy payload carries no size check; apply the current floor so a $0.02
  // position cannot slip through on a plan written before the rule existed.
  const deployed = Number(payload.capital?.deployedUsd ?? 0);
  if (deployed > 0 && deployed < MIN_POSITION_USD) {
    out.push(`规模过小（本金 ${deployed} USD，下限 ${MIN_POSITION_USD} USD）`);
  }

  return [...new Set(out)];
}
