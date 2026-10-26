/**
 * evidence.bundle — assembles the complete, deterministic fact set for one
 * research subject (a pool or a news item).
 *
 * This is the ONLY input the LLM receives. Nothing else. That constraint is
 * what makes the validator able to check every number in the report.
 */

import { ResultBuilder } from "./result.ts";
import { poolDetail, tokenPools, tokenProfile } from "./pools.ts";
import { newsRank } from "./news.ts";
import { computeScore, WEIGHTS_VERSION } from "./score.ts";
import { realizedVol, suggestRange, rangeCoverageProb, ilPct, type Candle, type VolStats } from "./metrics.ts";
import { fetchJson } from "../http.ts";
import { fmtUsd, fmtPct, round, truncate } from "../util.ts";
import { all } from "../db.ts";
import type { Fact, PoolRow } from "../types.ts";

export type SubjectKind = "pool" | "news";

export interface EvidenceBundle {
  version: string;
  subjectKind: SubjectKind;
  subjectId: string;
  subjectLabel: string;
  /** compact human/LLM readable facts */
  facts: Record<string, string | number | null>;
  /** every numeric value allowed to appear in a report */
  allowedNumbers: number[];
  sections: {
    pool?: {
      name: string;
      dex: string;
      tvl: string;
      vol24h: string;
      feeApr: string;
      turnover: string;
      ageDays: number | null;
      feeTier: number | null;
      price: string;
      change24h: string;
      seriesPoints: number;
      volSeries: number[];
    };
    score?: {
      total: number;
      grade: string;
      confidence: number;
      dims: { label: string; score: number; weight: number; note: string }[];
      gates: { label: string; blocked: boolean; severity: string; detail: string }[];
      reasons: string[];
      risks: string[];
      weightsVersion: string;
    };
    siblings?: { name: string; tvl: string; feeApr: string; turnover: string }[];
    risk?: {
      vol30dPct: number | null;
      vol7dPct: number | null;
      pricePercentile: number | null;
      deviationFromMeanPct: number | null;
      rangeWindowDays: number;
      suggestedRange: { downPct: number; upPct: number; coverage: number } | null;
      coverageAt: { width: number; days: number; prob: number | null }[];
      ilTable: { movePct: number; ilPct: number }[];
      capitalUsd: number;
      maxPositionUsd: number;
    };
    token?: { symbol: string; name: string; price: string; fdv: string; mcap: string; vol24h: string } | null;
    news?: {
      title: string;
      source: string;
      publishedAt: number;
      summary: string;
      entities: string[];
      matched: string[];
      alsoCoveredBy: string[];
    };
    marketContext?: { symbol: string; price: string }[];
  };
  sources: { name: string; url?: string }[];
  degraded: boolean;
  degradedReason?: string;
  generatedAt: number;
}

/**
 * Collect every number that appears in a string, so the validator can permit it.
 * Magnitude words are expanded: "$404 million" becomes 404000000, "4.04亿" the
 * same. Without this the model's perfectly correct restatement ("4.04 亿")
 * looks like a fabricated number and the whole report gets thrown away.
 */
const MAGNITUDE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
  万: 1e4, 亿: 1e8,
};

export function harvestNumbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  else if (typeof v === "string") {
    for (const m of v.matchAll(/(-?\d[\d,]*\.?\d*)\s*(k|mn|m|bn|b|t|thousand|million|billion|trillion|万|亿)?/gi)) {
      const n = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(n)) continue;
      out.push(n);
      const unit = (m[2] ?? "").toLowerCase();
      const mult = MAGNITUDE[unit];
      if (mult) out.push(n * mult);
    }
  } else if (Array.isArray(v)) for (const x of v) harvestNumbers(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) harvestNumbers(x, out);
  return out;
}

export async function buildPoolEvidence(
  chain: string,
  address: string,
  opts: { capitalUsd?: number; riskTier?: 1 | 2 | 3 } = {},
): Promise<EvidenceBundle | { error: string }> {
  const detail = await poolDetail(chain, address);
  if (!detail.ok || !detail.data) return { error: detail.degradedReason ?? "pool detail unavailable" };

  const p = detail.data as PoolRow & { series: { t: number; c: number; v: number }[] };
  const score = computeScore(p, { capitalUsd: opts.capitalUsd ?? 2000, riskTier: opts.riskTier ?? 2 });

  let token = null;
  let siblings: any[] = [];
  const baseToken = await tokenProfile(chain, p.baseAddress);
  if (baseToken.ok && baseToken.data) {
    const t = baseToken.data;
    token = {
      symbol: t.symbol,
      name: t.name,
      price: fmtUsd(t.priceUsd, 4),
      fdv: fmtUsd(t.fdvUsd),
      mcap: fmtUsd(t.mcapUsd),
      vol24h: fmtUsd(t.volume24hUsd),
    };
  }
  const sib = await tokenPools(chain, p.baseAddress);
  if (sib.ok && sib.data) {
    siblings = (sib.data.rows as PoolRow[])
      .filter((r) => r.address.toLowerCase() !== p.address.toLowerCase())
      .slice(0, 5)
      .map((r) => ({
        name: truncate(r.name, 40),
        tvl: fmtUsd(r.tvlUsd),
        feeApr: fmtPct(r.feeAprPct, 1),
        turnover: r.turnover !== null ? `${r.turnover.toFixed(2)}x` : "—",
      }));
  }

  const series = p.series ?? [];
  const prices = series.map((x) => x.c);
  const vols = series.map((x) => x.v);

  // --- risk math: volatility, range coverage, IL, position sizing ---
  const candles: Candle[] = series.map((x) => ({ t: x.t, o: x.o ?? x.c, h: x.h ?? x.c, l: x.l ?? x.c, c: x.c, v: x.v ?? 0 }));
  const vol: VolStats = realizedVol(candles, 720);
  const holdDays = 14;
  const suggested = suggestRange(vol.vol30dPct, holdDays, 0.7);
  const coverageAt = [5, 10, 15, 20, 30].map((w) => ({
    width: w,
    days: holdDays,
    prob: rangeCoverageProb(vol.vol30dPct, w, w, holdDays),
  }));
  const ilTable = [-50, -30, -20, -10, -5, 5, 10, 20, 30, 50].map((m) => ({
    movePct: m,
    ilPct: ilPct(1 + m / 100),
  }));
  const capital = opts.capitalUsd ?? 2000;
  // never suggest more than 1/20 of pool TVL: at that size a full exit moves
  // the price enough to cost more than a week of fees
  const maxPosition = Math.min(capital, Math.floor((p.tvlUsd ?? 0) / 20));

  const sections: EvidenceBundle["sections"] = {
    pool: {
      name: p.name,
      dex: p.dex,
      tvl: fmtUsd(p.tvlUsd),
      vol24h: fmtUsd(p.vol24hUsd),
      feeApr: fmtPct(p.feeAprPct, 1),
      turnover: p.turnover !== null ? `${p.turnover.toFixed(2)}x` : "—",
      ageDays: p.ageDays !== null ? round(p.ageDays, 0) : null,
      feeTier: p.feeTierPct,
      price: fmtUsd(p.priceUsd, 4),
      change24h: fmtPct(p.priceChange24h),
      seriesPoints: series.length,
      volSeries: vols.slice(-24),
    },
    score: {
      total: score.total,
      grade: score.grade,
      confidence: score.confidence,
      dims: score.dims,
      gates: score.gates,
      reasons: score.reasons,
      risks: score.risks,
      weightsVersion: WEIGHTS_VERSION,
    },
    risk: {
      vol30dPct: vol.vol30dPct,
      vol7dPct: vol.vol7dPct,
      pricePercentile: vol.pricePercentile,
      deviationFromMeanPct: vol.deviationFromMeanPct,
      rangeWindowDays: holdDays,
      suggestedRange: suggested,
      coverageAt,
      ilTable,
      capitalUsd: capital,
      maxPositionUsd: maxPosition,
    },
    siblings,
    token,
  };

  const facts: Record<string, string | number | null> = {
    "池子": p.name,
    "DEX": p.dex,
    "TVL": fmtUsd(p.tvlUsd),
    "24h成交": fmtUsd(p.vol24hUsd),
    "fee APR(估算)": fmtPct(p.feeAprPct, 1),
    "换手率": p.turnover !== null ? `${p.turnover.toFixed(2)}x` : null,
    "池龄(天)": p.ageDays !== null ? round(p.ageDays, 0) : null,
    "费率档(%)": p.feeTierPct,
    "24h涨跌": fmtPct(p.priceChange24h),
    "30d年化波动(%)": vol.vol30dPct,
    "7d年化波动(%)": vol.vol7dPct,
    "价格百分位": vol.pricePercentile,
    "评分": score.total,
    "评级": score.grade,
    "置信度": score.confidence,
    "分析本金(USD)": capital,
    "单仓上限(USD)": maxPosition,
  };

  const allowed = harvestNumbers({ sections, facts });
  // prices from the chart are legitimate too
  for (const v of prices.slice(-48)) allowed.push(v);

  return {
    version: "evidence@1",
    subjectKind: "pool",
    subjectId: `${chain}:${address}`,
    subjectLabel: `${p.baseSymbol}/${p.quoteSymbol}${p.feeTierPct !== null ? " " + p.feeTierPct + "%" : ""}`,
    facts,
    allowedNumbers: dedupeNums(allowed),
    sections,
    sources: detail.sources.map((s) => ({ name: s.name, url: s.url })),
    degraded: detail.degraded,
    degradedReason: detail.degradedReason,
    generatedAt: Date.now(),
  };
}

export async function buildNewsEvidence(newsId: string): Promise<EvidenceBundle | { error: string }> {
  const row = all<any>(`SELECT * FROM news_items WHERE id = ?`, newsId)[0];
  if (!row) return { error: "news item not found" };

  const ranked = await newsRank({ limit: 200, hours: 168 });
  const match = ranked.ok ? ranked.data?.items.find((x) => x.id === newsId) : null;

  const entities: string[] = JSON.parse(row.entities || "[]");

  // Give the model live pool context for the story's tokens, so "AI 解读" can
  // say something concrete ("which pools does this touch") instead of narrating.
  const relatedPools: any[] = [];
  for (const sym of entities.slice(0, 3)) {
    const pools = all<any>(`SELECT * FROM feed_cards WHERE kind='pool' AND tags LIKE ? LIMIT 2`, `%${sym.toLowerCase()}%`);
    for (const pc of pools) {
      const pl = JSON.parse(pc.payload);
      if (!relatedPools.some((r) => r.address === pl.address)) {
        relatedPools.push({
          name: `${pl.baseSymbol}/${pl.quoteSymbol} ${pl.feeTierPct ?? ""}%`.trim(),
          address: pl.address,
          tvl: fmtUsd(pl.tvlUsd),
          vol24h: fmtUsd(pl.vol24hUsd),
          feeApr: fmtPct(pl.feeAprPct, 1),
          score: pl.score,
          grade: pl.grade,
        });
      }
    }
  }

  const sections: EvidenceBundle["sections"] = {
    news: {
      title: row.title,
      source: row.source_id,
      publishedAt: row.published_at,
      summary: row.summary,
      entities,
      matched: match?.matched ?? [],
      alsoCoveredBy: match?.alsoCoveredBy ?? [],
    },
    marketContext: relatedPools.map((p) => ({ symbol: p.name, price: p.feeApr })),
  };

  const facts: Record<string, string | number | null> = {
    "标题": row.title,
    "来源": row.source_id,
    "实体": entities.join(", "),
    "相关池数": relatedPools.length,
  };

  return {
    version: "evidence@1",
    subjectKind: "news",
    subjectId: newsId,
    subjectLabel: truncate(row.title, 80),
    facts,
    allowedNumbers: dedupeNums(harvestNumbers({ sections, facts, relatedPools })),
    sections: { ...sections, siblings: relatedPools },
    sources: [{ name: row.source_id, url: row.url }],
    degraded: false,
    generatedAt: Date.now(),
  };
}

function dedupeNums(nums: number[]): number[] {
  const set = new Set<number>();
  for (const n of nums) if (Number.isFinite(n)) set.add(Math.round(n * 10000) / 10000);
  return [...set];
}

export async function evidenceBundle(kind: SubjectKind, id: string, opts: any = {}) {
  const b = new ResultBuilder("evidence.bundle@1");
  if (kind === "pool") {
    const [chain, address] = id.split(":");
    const ev = await buildPoolEvidence(chain, address, opts);
    if ("error" in ev) return b.degrade(ev.error).fail(ev.error);
    b.fact("evidence.subject", "研究对象", ev.subjectLabel);
    b.fact("evidence.numbers", "允许引用的数字", ev.allowedNumbers.length, { unit: "个" });
    b.fact("evidence.degraded", "数据完整", ev.degraded ? "否" : "是");
    return b.ok(ev);
  }
  const ev = await buildNewsEvidence(id);
  if ("error" in ev) return b.degrade(ev.error).fail(ev.error);
  b.fact("evidence.subject", "研究对象", ev.subjectLabel);
  return b.ok(ev);
}
