/**
 * Market snapshot for the right rail.
 * Uses DefiLlama coins (multi-chain, has confidence) — one call, no key.
 */

import { fetchJson } from "../http.ts";
import { ResultBuilder } from "./result.ts";
import { num, round } from "../util.ts";

const IDS: Record<string, string> = {
  BTC: "coingecko:bitcoin",
  ETH: "coingecko:ethereum",
  SOL: "coingecko:solana",
  HYPE: "coingecko:hyperliquid",
};

export async function marketSnapshot(symbols = ["BTC", "ETH", "SOL", "HYPE"]) {
  const b = new ResultBuilder("market.snapshot@1");
  const list = symbols.map((s) => IDS[s]).filter(Boolean);
  const url = `https://coins.llama.fi/prices/current/${list.join(",")}`;
  const r = await fetchJson<any>(url, { cacheTtlMs: 60_000, minIntervalMs: 500 });
  if (!r.ok || !r.data?.coins) {
    b.degrade(r.error ?? "prices unavailable");
    return b.ok({ asOf: Date.now(), rows: [] });
  }

  const rows = symbols.map((sym) => {
    const c = r.data!.coins[IDS[sym]];
    return {
      symbol: sym,
      price: c ? round(num(c.price), 2) : null,
      confidence: c ? num(c.confidence) : null,
      ts: c ? c.timestamp * 1000 : null,
    };
  });

  b.source("DefiLlama coins", url);
  for (const x of rows) if (x.price !== null) b.fact(`mkt.${x.symbol}`, x.symbol, x.price, { unit: "USD" });

  return b.ok({ asOf: Date.now(), rows });
}
