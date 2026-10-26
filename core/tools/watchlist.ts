/**
 * Watchlist: tokens and pools the user asked to keep an eye on.
 *
 * The table existed long before this file — news relevance scoring reads it —
 * but nothing could write to it, so "我的收藏" had no way to fill itself. This
 * module supplies the write side.
 *
 * One table serves two kinds of entry:
 *   - a token   (address = token contract, label = symbol)
 *   - a pool    (address = pool contract,  label = "USDC / USDG 0.01%")
 *
 * They share the schema because consumers only ever ask "which symbols does this
 * user care about", and both kinds answer that. A separate table would duplicate
 * the relevance logic for no gain.
 */

import { all, one, run } from "../db.ts";

export interface WatchEntry {
  chain: string;
  address: string;
  label: string | null;
  addedAt: number | null;
}

export function listWatchlist(chain?: string): WatchEntry[] {
  const rows = chain
    ? all<any>(`SELECT * FROM watchlist WHERE chain=? ORDER BY added_at DESC`, chain)
    : all<any>(`SELECT * FROM watchlist ORDER BY added_at DESC`);
  return rows.map((r) => ({
    chain: String(r.chain),
    address: String(r.address),
    label: r.label ? String(r.label) : null,
    addedAt: r.added_at != null ? Number(r.added_at) : null,
  }));
}

export function isWatched(chain: string, address: string): boolean {
  return Boolean(one<any>(`SELECT 1 AS x FROM watchlist WHERE chain=? AND address=?`, chain, address));
}

/**
 * Add or refresh an entry.
 *
 * `label` is refreshed on re-add: a pool can be renamed upstream, and a stale
 * label would make the relevance matcher look for a token that no longer exists.
 */
export function addWatch(chain: string, address: string, label?: string | null): WatchEntry {
  const now = Date.now();
  run(
    `INSERT INTO watchlist (chain,address,label,added_at) VALUES (?,?,?,?)
     ON CONFLICT(chain,address) DO UPDATE SET
       label=COALESCE(excluded.label, watchlist.label),
       added_at=excluded.added_at`,
    chain, address, label ?? null, now,
  );
  return { chain, address, label: label ?? null, addedAt: now };
}

export function removeWatch(chain: string, address: string): boolean {
  const before = isWatched(chain, address);
  if (before) run(`DELETE FROM watchlist WHERE chain=? AND address=?`, chain, address);
  return before;
}
