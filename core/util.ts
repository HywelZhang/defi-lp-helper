import { createHash } from "node:crypto";

export const nowSec = () => Math.floor(Date.now() / 1000);
export const nowMs = () => Date.now();

export function sha(s: string, len = 16): string {
  return createHash("sha256").update(s).digest("hex").slice(0, len);
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function round(n: number | null, d = 2): number | null {
  if (n === null) return null;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Human-compact USD for UI and prompts; keeps LLM from re-formatting numbers. */
export function fmtUsd(n: number | null, d = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(d)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(d)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(d === 2 ? 1 : d)}K`;
  if (a >= 1) return `$${n.toFixed(d)}`;
  return `$${n.toPrecision(3)}`;
}

export function fmtPct(n: number | null, d = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
}

export function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400_000);
}

export function hoursAgo(sec: number): number {
  return (nowSec() - sec) / 3600;
}

/** Strip tags/entities and collapse whitespace. */
export function plain(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

/**
 * Normalized title fingerprint for cross-source dedupe.
 * Two outlets covering one story usually share most tokens.
 */
export function fingerprint(title: string): string {
  const norm = plain(title)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort()
    .slice(0, 12)
    .join("-");
  return sha(norm, 12);
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "says", "said", "will",
  "has", "have", "are", "was", "were", "its", "his", "her", "not", "but", "you",
  "can", "now", "new", "over", "into", "after", "amid", "about", "report",
]);

/** Token-ish mentions: $TICKER plus a seed dictionary of majors. */
const MAJORS = [
  "BTC", "ETH", "SOL", "USDC", "USDT", "DAI", "WETH", "WBTC", "ARB", "OP",
  "MATIC", "AVAX", "LINK", "UNI", "AAVE", "CRV", "LDO", "MKR", "PEPE", "DOGE",
  "SHIB", "WIF", "BONK", "TIA", "SUI", "APT", "SEI", "INJ", "JUP", "PYTH",
  "AERO", "WELL", "CBETH", "RETH", "EZETH", "USDE", "SUSDE", "ONDO", "ENA",
  "MORPHO", "EIGEN", "HYPE", "VIRTUAL", "AI16Z", "FARTCOIN", "TRUMP",
];

/**
 * Articles write "bitcoin", not "$BTC". Without alias handling the watchlist
 * never matches and every feed looks identical.
 */
const ALIASES: Record<string, string> = {
  bitcoin: "BTC", btc: "BTC",
  ethereum: "ETH", ether: "ETH", eth: "ETH",
  solana: "SOL", sol: "SOL",
  uniswap: "UNI", uni: "UNI",
  aerodrome: "AERO", aero: "AERO",
  arbitrum: "ARB", arb: "ARB", optimism: "OP",
  ripple: "XRP", xrp: "XRP",
  dogecoin: "DOGE", doge: "DOGE",
  pepe: "PEPE", bonk: "BONK",
  chainlink: "LINK", link: "LINK",
  aave: "AAVE", curve: "CRV", lido: "LDO", maker: "MKR",
  tether: "USDT", usdt: "USDT",
  "usd coin": "USDC", usdc: "USDC",
  dai: "DAI", frax: "FRAX",
  hyperliquid: "HYPE", hype: "HYPE",
  morpho: "MORPHO", eigenlayer: "EIGEN", eigen: "EIGEN",
  ondo: "ONDO", ethena: "ENA", ena: "ENA",
  stablecoin: "STABLE", stablecoins: "STABLE",
  "liquidity pool": "LP", "liquidity pools": "LP", lp: "LP",
  "yield farming": "YIELD", defi: "DEFI",
};

/** Returns uppercase symbols found in text, deterministic order. */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();

  // explicit cashtags: $BTC
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) {
    found.add(m[1].toUpperCase());
  }

  const lower = text.toLowerCase();

  // word-boundary alias lookup (handles "bitcoin" -> BTC)
  for (const [word, sym] of Object.entries(ALIASES)) {
    const re = new RegExp(`(^|[^a-z0-9])${word.replace(/ /g, "\\s+")}([^a-z0-9]|$)`);
    if (re.test(lower)) found.add(sym);
  }

  // bare uppercase tickers (careful: only if 2-6 chars and standalone)
  const upper = text.toUpperCase();
  for (const sym of MAJORS) {
    const re = new RegExp(`(^|[^A-Z0-9])${sym}([^A-Z0-9]|$)`);
    if (re.test(upper)) found.add(sym);
  }

  return [...found].sort();
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}
