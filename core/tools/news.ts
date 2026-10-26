/**
 * News tools: fetch + normalize + entity extraction + cross-source dedupe + ranking.
 *
 * Ranking is deterministic and explainable:
 *   rank = relevance * freshness * sourceWeight * (1 + entityBoost)
 * relevance comes from the user's watchlist and (later) open positions.
 */

import { fetchText } from "../http.ts";
import { ResultBuilder } from "./result.ts";
import { extractEntities, fingerprint, plain, truncate, sha } from "../util.ts";
import { all, run } from "../db.ts";
import type { NewsItem } from "../types.ts";

export interface SourceDef {
  id: string;
  name: string;
  url: string;
  weight: number;
  lang: "en" | "zh";
}

export const SOURCES: SourceDef[] = [
  { id: "decrypt", name: "Decrypt", url: "https://decrypt.co/feed", weight: 1.0, lang: "en" },
  { id: "cointelegraph", name: "Cointelegraph", url: "https://cointelegraph.com/rss", weight: 0.95, lang: "en" },
  { id: "theblock", name: "The Block", url: "https://www.theblock.co/rss.xml", weight: 1.05, lang: "en" },
  { id: "coindesk", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", weight: 1.0, lang: "en" },
  { id: "bitcoinmagazine", name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/", weight: 0.7, lang: "en" },
];

interface RawItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
}

/** Minimal, tolerant RSS/Atom parser — no deps, handles CDATA + entities. */
export function parseRss(xml: string): RawItem[] {
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const pick = (block: string, tag: string): string => {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const m = block.match(re);
    if (!m) return "";
    return plain(m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, ""));
  };

  const out: RawItem[] = [];
  for (const b of blocks) {
    const title = pick(b, "title");
    if (!title) continue;
    let link = pick(b, "link");
    if (!link) {
      const alt = b.match(/<link[^>]*href="([^"]+)"/i);
      if (alt) link = alt[1];
    }
    const guid = pick(b, "guid") || pick(b, "id") || link || sha(title, 24);
    const pubDate = pick(b, "pubDate") || pick(b, "published") || pick(b, "updated") || "";
    const description = pick(b, "description") || pick(b, "summary") || pick(b, "content");
    out.push({ title, link, guid, pubDate, description });
  }
  return out;
}

function parseDate(s: string): number {
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.floor(t / 1000);
  return Math.floor(Date.now() / 1000);
}

/** Clean tracking params so the same story from a feed de-dupes better. */
export function cleanUrl(u: string): string {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|campaign|fbclid|gclid)/i.test(k)) url.searchParams.delete(k);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

// ---------- ingest ----------

export interface IngestStats {
  source: string;
  fetched: number;
  inserted: number;
  duplicate: number;
  error?: string;
}

export async function newsIngest(sourceIds?: string[]): Promise<IngestStats[]> {
  const targets = SOURCES.filter((s) => !sourceIds || sourceIds.includes(s.id));
  const stats: IngestStats[] = [];

  for (const s of targets) {
    const st: IngestStats = { source: s.id, fetched: 0, inserted: 0, duplicate: 0 };
    const r = await fetchText(s.url, {
      accept: "application/rss+xml, application/xml, text/xml",
      timeoutMs: 20000,
      minIntervalMs: 500,
    });
    if (!r.ok) {
      st.error = r.error;
      run(
        `INSERT INTO sources (id,name,kind,url,weight,last_error) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error`,
        s.id, s.name, "rss", s.url, s.weight, r.error ?? "unknown",
      );
      stats.push(st);
      continue;
    }

    const items = parseRss(r.body);
    st.fetched = items.length;

    for (const it of items) {
      const url = cleanUrl(it.link);
      if (!url) continue;
      const fp = fingerprint(it.title);
      const existing = all<{ id: string }>(
        `SELECT id FROM news_items WHERE source_id=? AND guid=?`,
        s.id, it.guid,
      );
      if (existing.length) { st.duplicate++; continue; }

      const text = `${it.title} ${it.description}`;
      const entities = extractEntities(text);
      const id = sha(`${s.id}:${it.guid}`, 20);
      const summary = truncate(plain(it.description), 400);

      try {
        run(
          `INSERT INTO news_items
           (id,source_id,guid,title,url,summary,published_at,fetched_at,entities,fingerprint)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          id, s.id, it.guid, truncate(it.title, 300), url, summary,
          parseDate(it.pubDate), Math.floor(Date.now() / 1000),
          JSON.stringify(entities), fp,
        );
        st.inserted++;
      } catch {
        st.duplicate++;
      }
    }

    run(
      `INSERT INTO sources (id,name,kind,url,weight,last_ok_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_ok_at=excluded.last_ok_at, last_error=NULL`,
      s.id, s.name, "rss", s.url, s.weight, Math.floor(Date.now() / 1000),
    );
    stats.push(st);
  }
  return stats;
}

// ---------- query ----------

const SEED_WATCH = [
  "WETH", "USDC", "WBTC", "AERO", "VIRTUAL", "CBETH", "USDT", "DAI",
];

export function getWatchlistSymbols(): string[] {
  const rows = all<{ address: string; label: string | null }>(
    `SELECT address,label FROM watchlist`,
  );
  const syms = new Set(SEED_WATCH);
  for (const r of rows) if (r.label) syms.add(r.label.toUpperCase());
  return [...syms];
}

export interface RankedNews extends NewsItem {
  rank: number;
  relevance: number;
  matched: string[];
  alsoCoveredBy: string[];
}

/**
 * Topic gate. A DeFi LP feed that shows "Google updates privacy policy" is
 * broken regardless of how well it ranks. Sources publish general tech news,
 * so relevance must be gated on domain vocabulary before ranking.
 */
const CRYPTO_SIGNALS = [
  /\b(bitcoin|btc|ethereum|eth|solana|crypto|defi|stablecoin|blockchain|web3|token|tokeniz)/i,
  /\b(uniswap|aerodrome|curve|balancer|aave|morpho|pendle|lido|eigen|hyperliquid|coinbase|binance|kraken|okx)/i,
  /\b(liquidity|yield|apy|apr|tvl|staking|restaking|lend|borrow|swap|pool|vault|amm|dex|cex|dex|perp)/i,
  /\b(wallet|on-chain|onchain|layer 2|l2|rollup|validator|mining|halving|airdrop|nft|dao|smart contract)/i,
  /\b(sec|cftc|etf|treasury|digital asset|cbdc)/i,
];

/** Hard-off-topic patterns: general big-tech/consumer news that bleeds in. */
const OFFTOPIC = [
  /\b(chatgpt|openai|copilot|gmail|google photos|windows update|android|iphone|ios \d)/i,
  /\b(mcdonald|microsoft|google says|netflix|tiktok|facebook|instagram)\b/i,
];

export function cryptoRelevance(title: string, summary: string): { score: number; offTopic: boolean } {
  const t = `${title} ${summary}`;
  let hits = 0;
  for (const re of CRYPTO_SIGNALS) if (re.test(t)) hits++;
  const offTopic = OFFTOPIC.some((re) => re.test(title)) && hits === 0;
  return { score: hits / CRYPTO_SIGNALS.length, offTopic };
}

/**
 * Deterministic relevance score in [0,1].
 * entity in watchlist -> +0.45 each (cap 0.9); topic keywords -> +0.1..0.2
 */
export function scoreNews(
  item: { title: string; entities: string[]; publishedAt: number; sourceId: string },
  watch: Set<string>,
  weightOf: (id: string) => number,
): { rank: number; relevance: number; matched: string[] } {
  const matched = item.entities.filter((e) => watch.has(e));
  let relevance = Math.min(0.9, matched.length * 0.45);

  const t = item.title.toLowerCase();
  if (/(uniswap|aerodrome|curve|balancer|liquidity|yield|apr|tvl)/.test(t)) relevance += 0.18;
  if (/(hack|exploit|depeg|rug|paused|halt)/.test(t)) relevance += 0.2;
  if (/(sec|etf|fed|rate cut|regulation)/.test(t)) relevance += 0.08;
  relevance = Math.min(1, relevance);

  const ageH = Math.max(0.2, (Date.now() / 1000 - item.publishedAt) / 3600);
  const freshness = 1 / Math.pow(ageH + 2, 0.55);
  const w = weightOf(item.sourceId);

  const rank = (0.25 + relevance) * freshness * w;
  return { rank, relevance, matched };
}

export async function newsRank(opts: {
  limit?: number;
  hours?: number;
  kinds?: string[];
} = {}) {
  const b = new ResultBuilder("news.rank@1");
  const limit = opts.limit ?? 30;
  const hours = opts.hours ?? 72;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;

  const rows = all<any>(
    `SELECT n.*, s.name AS source_name, s.weight AS source_weight
     FROM news_items n JOIN sources s ON s.id = n.source_id
     WHERE n.published_at >= ? ORDER BY n.published_at DESC LIMIT 800`,
    since,
  );

  const watch = new Set(getWatchlistSymbols());
  const wmap = new Map<string, number>();
  for (const r of rows) wmap.set(r.source_id, r.source_weight ?? 1);

  // drop off-topic and non-crypto items before any ranking happens
  const relevant = rows.filter((r) => {
    const c = cryptoRelevance(r.title, r.summary ?? "");
    return !c.offTopic && c.score >= 0.2;
  });
  const filteredOut = rows.length - relevant.length;

  // cross-source duplicate grouping: same fingerprint => one primary + "also covered"
  const byFp = new Map<string, any[]>();
  for (const r of relevant) {
    const arr = byFp.get(r.fingerprint) ?? [];
    arr.push(r);
    byFp.set(r.fingerprint, arr);
  }

  const ranked: RankedNews[] = [];
  for (const [, group] of byFp) {
    group.sort((a, z) => (z.source_weight ?? 1) - (a.source_weight ?? 1) || z.published_at - a.published_at);
    const primary = group[0];
    const entities = JSON.parse(primary.entities || "[]") as string[];
    const s = scoreNews(
      { title: primary.title, entities, publishedAt: primary.published_at, sourceId: primary.source_id },
      watch, (id) => wmap.get(id) ?? 1,
    );
    ranked.push({
      id: primary.id,
      sourceId: primary.source_id,
      sourceName: primary.source_name,
      guid: primary.guid,
      title: primary.title,
      url: primary.url,
      summary: primary.summary,
      publishedAt: primary.published_at,
      fetchedAt: primary.fetched_at,
      entities,
      fingerprint: primary.fingerprint,
      rank: s.rank,
      relevance: s.relevance,
      matched: s.matched,
      alsoCoveredBy: group.slice(1).map((g) => g.source_name),
    });
  }

  ranked.sort((a, z) => z.rank - a.rank);
  const out = ranked.slice(0, limit);

  b.source("news pool (5 rss sources)");
  b.fact("news.count", "候选新闻", rows.length, { unit: "items" });
  b.fact("news.relevant", "通过主题过滤", relevant.length, { unit: "items" });
  if (filteredOut) b.fact("news.filtered", "过滤离题", filteredOut, { unit: "items" });
  b.fact("news.hot", "命中关注 token", out.filter((x) => x.matched.length > 0).length, { unit: "items" });
  if (out[0]) b.fact("news.top", "最高相关", truncate(out[0].title, 80));

  return b.ok({ count: out.length, items: out, watchlist: [...watch] });
}
