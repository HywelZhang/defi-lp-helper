/**
 * score.compute — deterministic LP scoring.
 *
 * Design rule: this file contains the ONLY place thresholds live in code.
 * Skill references/scoring.md mirrors these numbers for prompts; a test
 * asserts they match (tests/scoring-sync.test.ts).
 */

import { ResultBuilder } from "./result.ts";
import { clamp, round, fmtUsd, fmtPct, truncate } from "../util.ts";
import type { PoolRow } from "../types.ts";

export const WEIGHTS_VERSION = "scoring@2026-10-25.1";

export interface Gates {
  id: string;
  label: string;
  blocked: boolean;
  detail: string;
  severity: "block" | "warn";
}

export interface DimensionScore {
  id: string;
  label: string;
  weight: number;
  score: number; // 0-100
  note: string;
}

export interface ScoreResult {
  total: number;
  grade: "A" | "B" | "C" | "D" | "F";
  confidence: number; // 0-1, data completeness
  gates: Gates[];
  dims: DimensionScore[];
  reasons: string[];
  risks: string[];
}

export const THRESHOLDS = {
  minTvlUsd: 200_000,
  minVol24hUsd: 50_000,
  minTurnover: 0.05,
  minPoolAgeHours: 48,
  maxFeeTierPct: 5,
  warnTvlUsd: 500_000,
  goodFeeAprPct: 15,
  greatFeeAprPct: 40,
  warnFeeAprPct: 300,
} as const;

export const WEIGHTS = {
  yieldQuality: 0.25,
  ilRisk: 0.25,
  assetQuality: 0.2,
  depth: 0.15,
  fit: 0.15,
} as const;

export interface ScoreOpts {
  /** user capital in USD, drives fit dimension + capacity gate */
  capitalUsd?: number;
  /** risk appetite 1..3 */
  riskTier?: 1 | 2 | 3;
  /** symbols the user historically favors (from style profile) */
  preferSymbols?: string[];
  /** symbols the realised record says to stop repeating */
  avoidSymbols?: string[];
}

const STABLE = new Set(["USDC", "USDT", "DAI", "USDS", "GHO", "LUSD", "FRAX", "CRVUSD", "USDE", "PYUSD"]);
const BLUE = new Set(["WETH", "ETH", "WBTC", "BTC", "CBETH", "RETH", "WSTETH", "AERO", "USDC", "USDT", "DAI"]);

export function computeScore(pool: PoolRow, opts: ScoreOpts = {}): ScoreResult {
  const capital = opts.capitalUsd ?? 1_000;
  const riskTier = opts.riskTier ?? 2;
  const prefer = (opts.preferSymbols ?? []).map((s) => s.toUpperCase());
  const avoid = (opts.avoidSymbols ?? []).map((s) => s.toUpperCase());

  const tvl = pool.tvlUsd ?? 0;
  const vol24 = pool.vol24hUsd ?? 0;
  const age = pool.ageDays ?? 0;
  const feeApr = pool.feeAprPct;
  const turnover = pool.turnover ?? 0;
  const bothStable = STABLE.has(pool.baseSymbol.toUpperCase()) && STABLE.has(pool.quoteSymbol.toUpperCase());
  const hasBlue = BLUE.has(pool.baseSymbol.toUpperCase()) || BLUE.has(pool.quoteSymbol.toUpperCase());

  // ---------- gates ----------
  const gates: Gates[] = [];
  const g = (id: string, label: string, blocked: boolean, detail: string, severity: "block" | "warn" = "block") =>
    gates.push({ id, label, blocked, detail, severity });

  // Detail strings are neutral ("actual, vs threshold") on purpose: they render
  // on both the pass and fail path, so wording must not presuppose failure.
  g("tvl_min", "TVL 门槛", tvl < THRESHOLDS.minTvlUsd,
    `${fmtUsd(tvl)}（门槛 ${fmtUsd(THRESHOLDS.minTvlUsd)}）`);
  g("vol_min", "成交门槛", vol24 < THRESHOLDS.minVol24hUsd,
    `24h ${fmtUsd(vol24)}（门槛 ${fmtUsd(THRESHOLDS.minVol24hUsd)}）`);
  g("turnover_min", "换手率", turnover < THRESHOLDS.minTurnover,
    `${turnover.toFixed(3)}x（门槛 ${THRESHOLDS.minTurnover}x）`);
  g("age_min", "池龄", age * 24 < THRESHOLDS.minPoolAgeHours,
    `${age.toFixed(1)} 天（门槛 ${(THRESHOLDS.minPoolAgeHours / 24).toFixed(0)} 天）`, "warn");
  g("capacity", "容量 vs 本金", capital > 0 && tvl < capital * 20,
    `容量 ${capital > 0 ? (tvl / capital).toFixed(0) : "—"}x 本金（门槛 20x）`);
  g("fee_tier", "费率档上限", (pool.feeTierPct ?? 0) > THRESHOLDS.maxFeeTierPct,
    `${pool.feeTierPct ?? "—"}%（上限 ${THRESHOLDS.maxFeeTierPct}%）`);
  g("apr_outlier", "APR 可信度", feeApr !== null && feeApr > THRESHOLDS.warnFeeAprPct,
    `${fmtPct(feeApr, 1)}（警戒 ${THRESHOLDS.warnFeeAprPct}%，超限可能为刷量）`, "warn");

  const blocked = gates.some((x) => x.blocked && x.severity === "block");

  // ---------- dimensions ----------
  // 1) yield quality: level + plausibility. Rewards sustained-but-sane APR.
  let yieldScore = 0;
  if (feeApr !== null) {
    if (feeApr <= 0) yieldScore = 5;
    else if (feeApr < 5) yieldScore = 35;
    else if (feeApr < 15) yieldScore = 55 + ((feeApr - 5) / 10) * 15;
    else if (feeApr < 40) yieldScore = 70 + ((feeApr - 15) / 25) * 20;
    else if (feeApr < 100) yieldScore = 90 - ((feeApr - 40) / 60) * 25;
    else yieldScore = clamp(65 - (feeApr - 100) / 20, 10, 65);
  }
  if (turnover > 2) yieldScore -= 10; // churn risk
  if (turnover > 0.3 && turnover < 3) yieldScore += 5;
  yieldScore = clamp(yieldScore, 0, 100);

  // 2) IL / volatility risk: stable pairs are near-riskless; two volatile assets worst.
  let ilScore: number;
  if (bothStable) ilScore = 95;
  else if (hasBlue && (STABLE.has(pool.baseSymbol.toUpperCase()) || STABLE.has(pool.quoteSymbol.toUpperCase()))) ilScore = 72;
  else if (hasBlue) ilScore = 55;
  else ilScore = 30;
  const chg = Math.abs(pool.priceChange24h ?? 0);
  if (chg > 25) ilScore -= 20;
  else if (chg > 10) ilScore -= 10;
  ilScore = clamp(ilScore, 0, 100);

  // 3) asset quality: blue chips and stables are trusted; unknown memes are not.
  let assetScore = 40;
  if (bothStable) assetScore = 90;
  else if (hasBlue && (BLUE.has(pool.baseSymbol.toUpperCase()) && BLUE.has(pool.quoteSymbol.toUpperCase()))) assetScore = 88;
  else if (hasBlue) assetScore = 62;
  else if (age > 180) assetScore = 50;
  else assetScore = 30;
  if (prefer.includes(pool.baseSymbol.toUpperCase()) || prefer.includes(pool.quoteSymbol.toUpperCase())) assetScore += 6;
  // A pool built on a symbol that repeatedly lost money is a repeat of a known
  // mistake, not a fresh idea. Penalty is deliberately smaller than the reward,
  // so an outstanding pool can still win through its other dimensions.
  if (avoid.includes(pool.baseSymbol.toUpperCase()) || avoid.includes(pool.quoteSymbol.toUpperCase())) assetScore -= 8;
  assetScore = clamp(assetScore, 0, 100);

  // 4) depth: log-scaled TVL, with a penalty when 24h volume dwarfs liquidity.
  const depthScore = clamp((Math.log10(Math.max(tvl, 1)) - 4.3) * 38, 0, 100);
  const flowPenalty = turnover > 8 ? 15 : 0;

  // 5) fit: capital capacity + risk tier alignment
  const capacityRatio = capital > 0 ? tvl / capital : 0;
  let fitScore = clamp((Math.log10(Math.max(capacityRatio, 1)) / Math.log10(500)) * 100, 0, 100);
  const poolRisk = bothStable ? 1 : hasBlue ? 2 : 3;
  if (poolRisk > riskTier) fitScore -= 25 * (poolRisk - riskTier);
  if (poolRisk < riskTier) fitScore -= 8;
  fitScore = clamp(fitScore, 0, 100);

  const dims: DimensionScore[] = [
    { id: "yieldQuality", label: "收益质量", weight: WEIGHTS.yieldQuality, score: Math.round(yieldScore),
      note: feeApr === null ? "费率档未知，无法估算" : `fee APR ${fmtPct(feeApr, 1)}，换手 ${turnover.toFixed(2)}x` },
    { id: "ilRisk", label: "波动/IL 风险", weight: WEIGHTS.ilRisk, score: Math.round(ilScore),
      note: bothStable ? "稳定对，IL 接近零" : hasBlue ? "含蓝筹资产，IL 中等" : "双波动资产，IL 风险高" },
    { id: "assetQuality", label: "资产质量", weight: WEIGHTS.assetQuality, score: Math.round(assetScore),
      note: bothStable ? "双稳定币" : hasBlue ? "蓝筹参与" : "长尾资产" },
    { id: "depth", label: "深度与流动性", weight: WEIGHTS.depth, score: Math.round(clamp(depthScore - flowPenalty, 0, 100)),
      note: `TVL ${fmtUsd(tvl)}，24h 成交 ${fmtUsd(vol24)}` },
    { id: "fit", label: "与你匹配度", weight: WEIGHTS.fit, score: Math.round(fitScore),
      note: `容量 ${capacityRatio.toFixed(0)}x 本金，风险档 ${poolRisk}/3` },
  ];

  const total = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0));

  // confidence: how much of the picture we actually have
  let confidence = 1;
  if (pool.feeTierPct === null) confidence -= 0.25;
  if (pool.tvlUsd === null) confidence -= 0.2;
  if (pool.vol24hUsd === null) confidence -= 0.15;
  if (pool.ageDays === null) confidence -= 0.1;
  if (pool.priceChange24h === null) confidence -= 0.05;
  confidence = clamp(round(confidence, 2) ?? 0, 0, 1);

  const grade: ScoreResult["grade"] =
    blocked ? "F" : total >= 80 ? "A" : total >= 68 ? "B" : total >= 55 ? "C" : total >= 42 ? "D" : "F";

  // ---------- reasons (always numeric) ----------
  const reasons: string[] = [];
  const top = dims.slice().sort((a, b) => b.score * b.weight - a.score * a.weight)[0];
  const worst = dims.slice().sort((a, b) => a.score - b.score)[0];

  reasons.push(
    `${top.label} ${top.score} 分为最强项：${top.note}`,
  );
  if (feeApr !== null) {
    const daily = (feeApr / 365).toFixed(2);
    reasons.push(`按当前成交推算日化约 ${daily}%，年化 ${fmtPct(feeApr, 1)}（基于全部成交走同一费率档，属上限估算）`);
  }
  if (worst.score < 55) reasons.push(`最弱项是${worst.label}（${worst.score} 分）：${worst.note}`);

  const risks: string[] = [];
  if (bothStable && feeApr !== null && feeApr < 8) risks.push("稳定对收益偏低，扣掉 gas 与管理成本后可能不如闲置");
  if (!hasBlue && !bothStable) risks.push("长尾资产，价格可能快速偏离区间导致 IL 放大");
  if (turnover > 5) risks.push(`换手 ${turnover.toFixed(1)}x 偏高，成交可能由少数地址刷出`);
  if (age < 14) risks.push(`池子仅 ${age.toFixed(0)} 天，TVL 与费率尚未经检验`);
  if (pool.feeTierPct !== null && pool.feeTierPct >= 1) risks.push("高费率档，成交集中在少数大额 swap，收益波动大");

  return { total, grade, confidence, gates, dims, reasons, risks };
}

export async function scoreCompute(pull: PoolRow, opts: ScoreOpts = {}) {
  const b = new ResultBuilder("score.compute@1");
  const s = computeScore(pull, opts);

  b.fact("score.total", "总分", s.total, { unit: "pts" });
  b.fact("score.grade", "评级", s.grade);
  b.fact("score.confidence", "置信度", s.confidence, { unit: "0-1" });
  for (const d of s.dims) b.fact(`score.${d.id}`, d.label, d.score, { unit: "pts" });
  for (const gate of s.gates.filter((x) => x.blocked)) {
    b.fact(`gate.${gate.id}`, `拦截：${gate.label}`, gate.detail);
  }
  b.fact("scoring.version", "权重版本", WEIGHTS_VERSION);

  return b.ok({ pool: truncate(pull.name, 60), address: pull.address, ...s });
}
