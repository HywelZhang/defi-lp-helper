/**
 * feed.build — turns facts (news + scored pools) into stable, deduped cards.
 *
 * Cards are persisted because the feed must not change retroactively when an
 * upstream API hiccups. Rebuilds only add new cards (dedupe_key is the guard).
 */

import { ResultBuilder } from "./result.ts";
import { newsRank, type RankedNews } from "./news.ts";
import { poolsList } from "./pools.ts";
import { computeScore, type ScoreResult } from "./score.ts";
import { DEFAULT_CHAIN } from "../config.ts";
import { run, all } from "../db.ts";
import { fmtUsd, fmtPct, sha, truncate, round } from "../util.ts";
import type { FeedCard, PoolRow } from "../types.ts";

const V = "feed.build@1";

export interface BuildOpts {
  capitalUsd?: number;
  riskTier?: 1 | 2 | 3;
  poolLimit?: number;
  newsLimit?: number;
  minScore?: number;
  persist?: boolean;
  /** which network to build pool cards from; defaults to the configured chain */
  chain?: string;
}

function insertCard(c: Omit<FeedCard, "id"> & { dedupeKey: string }): boolean {
  const id = sha(`feed:${c.dedupeKey}`, 20);
  try {
    run(
      `INSERT INTO feed_cards
       (id,kind,ref_type,ref_id,title,subtitle,payload,tags,rank_score,created_at,dedupe_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, c.kind, c.refType, c.refId, c.title, c.subtitle,
      JSON.stringify(c.payload), JSON.stringify(c.tags), c.rankScore, c.createdAt, c.dedupeKey,
    );
    return true;
  } catch {
    return false;
  }
}

function newsCard(n: RankedNews, createdAt: number): Omit<FeedCard, "id"> & { dedupeKey: string } {
  const tags = ["news", n.sourceName.toLowerCase().replace(/\s+/g, "-")];
  if (n.matched.length) tags.push("watch");
  for (const e of n.entities.slice(0, 3)) tags.push(e.toLowerCase());

  const why = n.matched.length
    ? `命中关注：${n.matched.join(" / ")}`
    : n.relevance > 0.15
      ? "LP / 收益赛道相关"
      : "行业要闻";

  return {
    kind: "news",
    refType: "news",
    refId: n.id,
    title: n.title,
    subtitle: why,
    payload: {
      url: n.url,
      source: n.sourceName,
      summary: n.summary,
      publishedAt: n.publishedAt,
      entities: n.entities,
      matched: n.matched,
      alsoCoveredBy: n.alsoCoveredBy,
      relevance: round(n.relevance, 2),
      why,
    },
    tags,
    rankScore: round(n.rank * 100, 2) ?? 0,
    createdAt,
    dedupeKey: `news:${n.fingerprint}`,
  };
}

function poolCard(
  p: PoolRow,
  s: ScoreResult,
  createdAt: number,
  kindTag: "pool" | "hot",
): Omit<FeedCard, "id"> & { dedupeKey: string } {
  const tags = ["pool", kindTag];
  for (const sym of [p.baseSymbol, p.quoteSymbol]) tags.push(sym.toLowerCase());
  if (s.grade === "A" || s.grade === "B") tags.push("high-score");
  const stables = ["USDC", "USDT", "DAI"];
  if (stables.includes(p.baseSymbol.toUpperCase()) && stables.includes(p.quoteSymbol.toUpperCase())) tags.push("stable");

  const headline = `${p.baseSymbol} / ${p.quoteSymbol} ${p.feeTierPct !== null ? p.feeTierPct + "%" : ""}`.trim();

  return {
    kind: "pool",
    refType: "pool",
    refId: `${p.chain}:${p.address}`,
    title: headline,
    subtitle: `${p.dex} · TVL ${fmtUsd(p.tvlUsd)} · 24h ${fmtUsd(p.vol24hUsd)}`,
    payload: {
      chain: p.chain,
      address: p.address,
      dex: p.dex,
      baseSymbol: p.baseSymbol,
      quoteSymbol: p.quoteSymbol,
      feeTierPct: p.feeTierPct,
      tvlUsd: p.tvlUsd,
      vol24hUsd: p.vol24hUsd,
      feeAprPct: p.feeAprPct !== null ? round(p.feeAprPct, 1) : null,
      turnover: p.turnover !== null ? round(p.turnover, 3) : null,
      priceUsd: p.priceUsd,
      priceChange24h: p.priceChange24h,
      ageDays: p.ageDays !== null ? round(p.ageDays, 0) : null,
      score: s.total,
      grade: s.grade,
      confidence: s.confidence,
      dims: s.dims,
      reasons: s.reasons,
      risks: s.risks,
      blocked: s.gates.filter((g) => g.blocked && g.severity === "block"),
      url: p.url,
    },
    tags,
    // score drives ordering; volume is a tiebreak so the feed is not static
    rankScore: round(s.total + Math.min(12, Math.log10(Math.max(p.vol24hUsd ?? 1, 1)) * 2), 2) ?? 0,
    createdAt,
    dedupeKey: `pool:${p.chain}:${p.address}:${s.total}`,
  };
}

export async function feedBuild(opts: BuildOpts = {}) {
  const b = new ResultBuilder(V);
  const persist = opts.persist !== false;
  const createdAt = Math.floor(Date.now() / 1000);
  const cards: (Omit<FeedCard, "id"> & { dedupeKey: string })[] = [];

  // ---- news ----
  const news = await newsRank({ limit: opts.newsLimit ?? 18, hours: 72 });
  if (news.ok && news.data) {
    for (const n of news.data.items) cards.push(newsCard(n, createdAt));
  } else {
    b.degrade(news.degradedReason ?? "news unavailable");
  }

  // ---- pools ----
  const pools = await poolsList({
    chain: opts.chain ?? DEFAULT_CHAIN,
    sort: "vol24h",
    minTvl: 250_000,
    limit: 60,
  });
  if (pools.ok && pools.data) {
    const scored = pools.data.rows
      .map((p: PoolRow) => ({ p, s: computeScore(p, { capitalUsd: opts.capitalUsd ?? 2_000, riskTier: opts.riskTier ?? 2 }) }))
      .filter((x: { p: PoolRow; s: ScoreResult }) => x.s.grade !== "F")
      .sort((a: any, z: any) => z.s.total - a.s.total)
      .slice(0, opts.poolLimit ?? 14);

    for (const x of scored) {
      if (opts.minScore && x.s.total < opts.minScore) continue;
      cards.push(poolCard(x.p, x.s, createdAt, "pool"));
    }
    b.fact("feed.scoredPools", "已评分池", scored.length, { unit: "pools" });
    b.fact("feed.avgScore", "平均分", round(scored.reduce((s: number, x: any) => s + x.s.total, 0) / Math.max(1, scored.length), 1), { unit: "pts" });
  } else {
    b.degrade(pools.degradedReason ?? "pools unavailable");
  }

  // One card per asset pair. A pair at 4 different fee tiers is 4 real products,
  // but 4 cards of WETH/USDC teaches the reader nothing — the feed keeps the best
  // one and advertises the rest as "另有 N 个费率档". Tier comparison lives in the
  // pool detail drawer, not in the stream.
  const pairBest = new Map<string, { card: any; count: number }>();
  const deduped: typeof cards = [];
  for (const c of cards) {
    if (c.kind !== "pool") { deduped.push(c); continue; }
    const pair = [c.payload.baseSymbol, c.payload.quoteSymbol]
      .map((s: string) => String(s).toUpperCase())
      .sort()
      .join("/");
    const cur = pairBest.get(pair);
    if (!cur) { pairBest.set(pair, { card: c, count: 1 }); continue; }
    cur.count++;
    if ((c.rankScore ?? 0) > (cur.card.rankScore ?? 0)) cur.card = c;
  }
  for (const [, v] of pairBest) {
    v.card.payload.siblingTiers = v.count - 1;
    deduped.push(v.card);
  }

  let inserted = 0;
  if (persist) for (const c of deduped) if (insertCard(c)) inserted++;

  deduped.sort((a, z) => z.rankScore - a.rankScore);

  b.source("feed pipeline (news + geckoterminal + score.compute)");
  b.fact("feed.cards", "生成卡片", deduped.length, { unit: "cards" });
  b.fact("feed.inserted", "新增入库", inserted, { unit: "cards" });
  b.fact("feed.news", "新闻卡", deduped.filter((c) => c.kind === "news").length, { unit: "cards" });
  b.fact("feed.pools", "池推荐卡", deduped.filter((c) => c.kind === "pool").length, { unit: "cards" });

  return b.ok({ createdAt, count: deduped.length, inserted, cards: deduped });
}

export function feedList(opts: { limit?: number; kinds?: string[]; sinceHours?: number } = {}) {
  const limit = opts.limit ?? 40;
  const since = Math.floor(Date.now() / 1000) - (opts.sinceHours ?? 72) * 3600;
  const kinds = opts.kinds?.length ? opts.kinds : null;

  const rows = all<any>(
    `SELECT * FROM feed_cards
     WHERE created_at >= ? ${kinds ? `AND kind IN (${kinds.map(() => "?").join(",")})` : ""}
     ORDER BY created_at DESC, rank_score DESC LIMIT ?`,
    since, ...(kinds ?? []), limit,
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    refType: r.ref_type,
    refId: r.ref_id,
    title: r.title,
    subtitle: r.subtitle,
    payload: JSON.parse(r.payload),
    tags: JSON.parse(r.tags || "[]"),
    rankScore: r.rank_score,
    createdAt: r.created_at,
  }));
}
