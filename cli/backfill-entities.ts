#!/usr/bin/env node
/** Backfill entity extraction for rows ingested before alias support. */
import { all, run } from "../core/db.ts";
import { extractEntities } from "../core/util.ts";

const rows = all<{ id: string; title: string; summary: string; entities: string }>(
  `SELECT id,title,summary,entities FROM news_items`,
);

let changed = 0;
for (const r of rows) {
  const next = extractEntities(`${r.title} ${r.summary ?? ""}`);
  const prev = JSON.parse(r.entities || "[]") as string[];
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    run(`UPDATE news_items SET entities=? WHERE id=?`, JSON.stringify(next), r.id);
    changed++;
  }
}
console.log(`backfilled ${changed}/${rows.length} rows`);
