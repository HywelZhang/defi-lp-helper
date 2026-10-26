/**
 * Domain types shared by tools, ingest and UI.
 * Rule: any number that a human or LLM reads must originate as a Fact.
 */

export type Chain = "x-layer" | "base" | "ethereum" | "arbitrum";

export interface Fact {
  id: string;
  label: string;
  value: string | number | null;
  unit?: string;
  ts: number;
  source: string;
  /** true when derived/approximate rather than directly reported */
  approx?: boolean;
}

export interface SourceRef {
  name: string;
  url?: string;
  ts: number;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data: T | null;
  facts: Fact[];
  sources: SourceRef[];
  /** set when some upstream input failed; UI must show data age */
  degraded: boolean;
  degradedReason?: string;
  tookMs: number;
  version: string;
}

export interface PoolRow {
  chain: string;
  address: string;
  dex: string;
  name: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseAddress: string;
  quoteAddress: string;
  feeTierPct: number | null;
  priceUsd: number | null;
  priceChange24h: number | null;
  tvlUsd: number | null;
  vol24hUsd: number | null;
  vol6hUsd: number | null;
  vol1hUsd: number | null;
  tx24h: number | null;
  createdAt: string | null;
  ageDays: number | null;
  feeAprPct: number | null;
  turnover: number | null;
  url: string;
}

export interface TokenProfile {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  fdvUsd: number | null;
  mcapUsd: number | null;
  totalSupply: number | null;
  volume24hUsd: number | null;
  imageUrl: string | null;
  cgId: string | null;
}

export interface NewsItem {
  id: string;
  sourceId: string;
  sourceName: string;
  guid: string;
  title: string;
  url: string;
  summary: string;
  publishedAt: number;
  fetchedAt: number;
  entities: string[];
  fingerprint: string;
}

export type FeedCardKind = "news" | "pool" | "position" | "rule";

export interface FeedCard {
  id: string;
  kind: FeedCardKind;
  refType: string;
  refId: string;
  title: string;
  subtitle: string;
  /** structured payload rendered by the client per kind */
  payload: Record<string, unknown>;
  rankScore: number;
  createdAt: number;
  tags: string[];
}
