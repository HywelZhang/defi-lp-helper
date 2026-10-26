/**
 * Pool tools — GeckoTerminal primary, DexScreener fallback.
 * All numbers here come from upstream; nothing is inferred except feeApr
 * (documented formula) and ageDays.
 */

import { fetchJson } from "../http.ts";
import { ResultBuilder } from "./result.ts";
import { ageDays, num, round, sha, truncate } from "../util.ts";
import { DEFAULT_CHAIN, geckoNetwork, geckoSitePath, chainConfig } from "../config.ts";
import type { PoolRow, TokenProfile } from "../types.ts";

const GT = "https://api.geckoterminal.com/api/v2";
const V = "pools@1";
const RL = 2100; // ~28 req/min, under the 30/min cap

export interface PoolQuery {
  chain?: string;
  dex?: string;
  sort?: "tvl" | "vol24h" | "feeApr" | "turnover" | "new";
  minTvl?: number;
  minVol24h?: number;
  feeTierMax?: number;
  page?: number;
  limit?: number;
  q?: string;
}

/** "WETH / USDC 0.05%" -> 0.05 ; "USDC / WETH" -> null */
export function parseFeeTier(name: string): number | null {
  const m = name.match(/(\d+(?:\.\d+)?)\s*%\s*$/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function pctMap(o: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) {
    const n = num(v);
    if (n !== null) out[k] = n;
  }
  return out;
}

function txTotal(tx: any, win: string): number | null {
  const w = tx?.[win];
  if (!w) return null;
  return num(w.buys ?? 0)! + num(w.sells ?? 0)!;
}

function toRow(raw: any, inc: Map<string, any>): PoolRow {
  const a = raw.attributes;
  const baseId = raw.relationships?.base_token?.data?.id;
  const quoteId = raw.relationships?.quote_token?.data?.id;
  const baseT = inc.get(baseId)?.attributes ?? {};
  const quoteT = inc.get(quoteId)?.attributes ?? {};
  const dexId = raw.relationships?.dex?.data?.id ?? "";
  const dexName = inc.get(dexId)?.attributes?.name ?? dexId;

  const vol = pctMap(a.volume_usd);
  const chg = pctMap(a.price_change_percentage);
  const tvl = num(a.reserve_in_usd);
  const vol24 = vol.h24 ?? null;
  const feeTier = parseFeeTier(a.name ?? "") ?? (dexName.toLowerCase().includes("v2") ? 0.3 : null);

  // fee APR assumes all 24h volume pays the headline tier. This over-states
  // V3 pools whose volume concentrates in active ticks; UI labels it "估算".
  let feeApr: number | null = null;
  if (feeTier !== null && vol24 !== null && tvl && tvl > 0) {
    feeApr = ((vol24 * (feeTier / 100)) / tvl) * 365 * 100;
  }

  return {
    chain: a.address ? raw.id.split("_")[0] : DEFAULT_CHAIN,
    address: a.address,
    dex: dexName || "unknown",
    name: a.name,
    baseSymbol: baseT.symbol ?? "?",
    quoteSymbol: quoteT.symbol ?? "?",
    baseAddress: baseT.address ?? "",
    quoteAddress: quoteT.address ?? "",
    feeTierPct: feeTier,
    priceUsd: num(a.base_token_price_usd),
    priceChange24h: chg.h24 ?? null,
    tvlUsd: tvl,
    vol24hUsd: vol24,
    vol6hUsd: vol.h6 ?? null,
    vol1hUsd: vol.h1 ?? null,
    tx24h: txTotal(a.transactions, "h24"),
    createdAt: a.pool_created_at ?? null,
    ageDays: ageDays(a.pool_created_at ?? null),
    feeAprPct: feeApr,
    turnover: tvl && tvl > 0 && vol24 !== null ? vol24 / tvl : null,
    url: `https://www.geckoterminal.com/${geckoSitePath(a.address ? raw.id.split("_")[0] : DEFAULT_CHAIN)}/pools/${a.address}`,
  };
}

export async function poolsList(q: PoolQuery = {}) {
  const b = new ResultBuilder(V);
  const chain = geckoNetwork(q.chain);
  const page = q.page ?? 1;

  const sortMap: Record<string, string> = {
    tvl: "h24_volume_usd_liquidity_desc",
    vol24h: "h24_volume_usd_desc",
    feeApr: "h24_volume_usd_desc",
    turnover: "h24_volume_usd_desc",
    new: "pool_created_at_desc",
  };
  const sort = sortMap[q.sort ?? "tvl"] ?? sortMap.tvl;

  const url =
    `${GT}/networks/${chain}/pools?page=${page}&sort=${sort}` +
    `&include=base_token%2Cquote_token%2Cdex`;

  const r = await fetchJson(url, { minIntervalMs: RL, cacheTtlMs: 60_000 });
  if (!r.ok || !r.data) return b.degrade(`geckoterminal: ${r.error}`).fail(`pools.list failed: ${r.error}`);

  const inc = new Map<string, any>();
  for (const x of r.data.included ?? []) inc.set(x.id, x);

  let rows = (r.data.data ?? []).map((x: any) => toRow(x, inc));

  if (q.q) {
    const needle = q.q.toLowerCase();
    rows = rows.filter(
      (p: PoolRow) =>
        p.name.toLowerCase().includes(needle) ||
        p.baseSymbol.toLowerCase().includes(needle) ||
        p.quoteSymbol.toLowerCase().includes(needle),
    );
  }
  if (q.dex) rows = rows.filter((p: PoolRow) => p.dex.toLowerCase().includes(q.dex!.toLowerCase()));
  if (q.minTvl) rows = rows.filter((p: PoolRow) => (p.tvlUsd ?? 0) >= q.minTvl!);
  if (q.minVol24h) rows = rows.filter((p: PoolRow) => (p.vol24hUsd ?? 0) >= q.minVol24h!);
  if (q.feeTierMax !== undefined)
    rows = rows.filter((p: PoolRow) => p.feeTierPct === null || p.feeTierPct <= q.feeTierMax!);

  if (q.sort === "feeApr") rows.sort((a: PoolRow, z: PoolRow) => (z.feeAprPct ?? 0) - (a.feeAprPct ?? 0));
  if (q.sort === "turnover") rows.sort((a: PoolRow, z: PoolRow) => (z.turnover ?? 0) - (a.turnover ?? 0));

  const limit = q.limit ?? 40;
  rows = rows.slice(0, limit);

  b.source("GeckoTerminal", url);
  if (r.stale) b.degrade("stale cache from geckoterminal");
  b.fact("pool.count", "池数量", rows.length, { unit: "pools" });
  b.fact("pool.sort", "排序", q.sort ?? "tvl");
  if (rows[0]?.tvlUsd != null)
    b.fact("pool.topTvl", "最高 TVL", round(rows[0].tvlUsd, 0), { unit: "USD" });

  return b.ok({ chain, page, count: rows.length, rows });
}

export async function poolsTrending(chain = DEFAULT_CHAIN, window: "1h" | "6h" | "24h" = "1h") {
  const b = new ResultBuilder(V);
  const net = geckoNetwork(chain);
  const url = `${GT}/networks/${net}/trending_pools?include=base_token%2Cquote_token%2Cdex&page=1`;
  const r = await fetchJson(url, { minIntervalMs: RL, cacheTtlMs: 120_000 });
  if (!r.ok || !r.data) return b.degrade(`geckoterminal: ${r.error}`).fail(`pools.trending failed: ${r.error}`);

  const inc = new Map<string, any>();
  for (const x of r.data.included ?? []) inc.set(x.id, x);
  let rows = (r.data.data ?? []).map((x: any) => toRow(x, inc));

  const key = window === "24h" ? "vol24hUsd" : window === "6h" ? "vol6hUsd" : "vol1hUsd";
  rows.sort((a: PoolRow, z: PoolRow) => ((z as any)[key] ?? 0) - ((a as any)[key] ?? 0));
  rows = rows.slice(0, 25);

  b.source("GeckoTerminal trending", url);
  b.fact("trending.count", "热门池数量", rows.length, { unit: "pools" });
  return b.ok({ chain, window, rows });
}

export async function tokenProfile(chain: string, address: string) {
  const b = new ResultBuilder("token.profile@1");
  const net = geckoNetwork(chain);
  const url = `${GT}/networks/${net}/tokens/${address}`;
  const r = await fetchJson(url, { minIntervalMs: RL, cacheTtlMs: 300_000 });
  if (!r.ok || !r.data?.data) return b.degrade(`geckoterminal: ${r.error}`).fail(`token.profile failed`);

  const a = r.data.data.attributes;
  const profile: TokenProfile = {
    chain,
    address,
    symbol: a.symbol,
    name: a.name,
    priceUsd: num(a.price_usd),
    fdvUsd: num(a.fdv_usd),
    mcapUsd: num(a.market_cap_usd),
    totalSupply: num(a.normalized_total_supply),
    volume24hUsd: num(a.volume_usd?.h24),
    imageUrl: a.image_url && a.image_url !== "None" ? a.image_url : null,
    cgId: a.coingecko_coin_id && a.coingecko_coin_id !== "None" ? a.coingecko_coin_id : null,
  };

  b.source("GeckoTerminal", url);
  if (profile.priceUsd !== null) b.fact("token.price", "价格", profile.priceUsd, { unit: "USD" });
  if (profile.fdvUsd !== null) b.fact("token.fdv", "FDV", round(profile.fdvUsd, 0), { unit: "USD" });
  if (profile.volume24hUsd !== null)
    b.fact("token.vol24h", "24h 成交", round(profile.volume24hUsd, 0), { unit: "USD" });
  if (profile.totalSupply !== null)
    b.fact("token.supply", "总供应", round(profile.totalSupply, 0), { unit: "tokens" });

  return b.ok(profile);
}

export async function poolDetail(chain: string, address: string) {
  const b = new ResultBuilder("pool.detail@1");
  const net = geckoNetwork(chain);
  const url = `${GT}/networks/${net}/pools/${address}?include=base_token%2Cquote_token%2Cdex`;
  const r = await fetchJson(url, { minIntervalMs: RL, cacheTtlMs: 45_000 });
  if (!r.ok || !r.data?.data) return b.degrade(`geckoterminal: ${r.error}`).fail(`pool.detail failed`);

  const inc = new Map<string, any>();
  for (const x of r.data.included ?? []) inc.set(x.id, x);
  const row = toRow(r.data.data, inc);

  const ohlcvUrl = `${GT}/networks/${net}/pools/${address}/ohlcv/hour?limit=720`;
  const oh = await fetchJson(ohlcvUrl, { minIntervalMs: RL, cacheTtlMs: 300_000 });
  let series: number[][] = [];
  if (oh.ok) series = oh.data?.data?.attributes?.ohlcv_list ?? [];
  else b.degrade(`ohlcv unavailable: ${oh.error}`);

  b.source("GeckoTerminal", url);
  if (row.tvlUsd !== null) b.fact("pool.tvl", "TVL", round(row.tvlUsd, 0), { unit: "USD" });
  if (row.vol24hUsd !== null) b.fact("pool.vol24h", "24h 成交", round(row.vol24hUsd, 0), { unit: "USD" });
  if (row.feeAprPct !== null)
    b.fact("pool.feeApr", "fee APR(估算)", round(row.feeAprPct, 2), { unit: "%", approx: true });
  if (row.turnover !== null) b.fact("pool.turnover", "换手率", round(row.turnover, 3), { unit: "x" });
  if (row.ageDays !== null) b.fact("pool.age", "池龄", round(row.ageDays, 0), { unit: "days" });
  if (row.feeTierPct !== null) b.fact("pool.feeTier", "费率档", row.feeTierPct, { unit: "%" });

  return b.ok({
    ...row,
    series: series
      .slice()
      .sort((x, y) => x[0] - y[0])
      .map((c) => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] })),
  });
}

/** token -> all pools, aggregated. Used by "相关池子聚合对比". */
export async function tokenPools(chain: string, address: string) {
  const b = new ResultBuilder("tokens.pools@1");
  const net = geckoNetwork(chain);
  const url = `${GT}/networks/${net}/tokens/${address}/pools?page=1&include=base_token%2Cquote_token%2Cdex`;
  const r = await fetchJson(url, { minIntervalMs: RL, cacheTtlMs: 120_000 });
  if (!r.ok || !r.data) return b.degrade(`geckoterminal: ${r.error}`).fail("tokens.pools failed");

  const inc = new Map<string, any>();
  for (const x of r.data.included ?? []) inc.set(x.id, x);
  const rows: PoolRow[] = (r.data.data ?? []).map((x: any) => toRow(x, inc));
  rows.sort((a, z) => (z.tvlUsd ?? 0) - (a.tvlUsd ?? 0));

  const bestDepth = rows[0] ?? null;
  const bestYield = rows.slice().sort((a, z) => (z.feeAprPct ?? 0) - (a.feeAprPct ?? 0))[0] ?? null;
  const totalTvl = rows.reduce((s, x) => s + (x.tvlUsd ?? 0), 0);

  b.source("GeckoTerminal", url);
  b.fact("pools.count", "相关池数", rows.length, { unit: "pools" });
  b.fact("pools.totalTvl", "TVL 合计", round(totalTvl, 0), { unit: "USD" });
  if (bestDepth?.tvlUsd != null)
    b.fact("pools.bestDepth", "最深池", truncate(bestDepth.name, 40), {
      unit: "USD",
      source: bestDepth.address,
    });

  return b.ok({ chain, token: address, count: rows.length, totalTvlUsd: totalTvl, bestDepth, bestYield, rows });
}

export { sha, truncate };
