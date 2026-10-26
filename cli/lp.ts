#!/usr/bin/env node
/**
 * lp — tool CLI. Same functions the web app and the agent use.
 *
 *   lp news.ingest
 *   lp news.rank --hours 24 --limit 20
 *   lp pools.list --sort vol24h --minTvl 500000
 *   lp score.compute 0xabc...
 *   lp feed.build
 *   lp feed.list --limit 20
 */

import { newsIngest, newsRank } from "../core/tools/news.ts";
import { poolsList, poolDetail, tokenProfile } from "../core/tools/pools.ts";
import { computeScore, scoreCompute } from "../core/tools/score.ts";
import { feedBuild, feedList } from "../core/tools/feed.ts";
import { DEFAULT_CHAIN } from "../core/config.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
    flags[k] = v;
  } else positional.push(a);
}

const N = (k: string, d?: number) => (flags[k] !== undefined ? Number(flags[k]) : d);
const S = (k: string, d?: string) => flags[k] ?? d;

function out(x: unknown) {
  const json = flags.json === "true";
  if (json) {
    console.log(JSON.stringify(x, null, 2));
    return;
  }
  console.log(pretty(x));
}

function pretty(x: any): string {
  if (Array.isArray(x)) return x.map((v) => "- " + JSON.stringify(v)).join("\n");
  if (x && typeof x === "object") {
    return Object.entries(x)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: [${v.length} items]`;
        if (v && typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
        return `${k}: ${v}`;
      })
      .join("\n");
  }
  return String(x);
}

function summary(r: any, rows?: any[], rowFmt?: (r: any) => string) {
  const { data, facts, ...rest } = r;
  console.log(`${rest.ok ? "OK" : "FAIL"}  ${rest.version}  ${rest.tookMs}ms${rest.degraded ? "  [DEGRADED: " + rest.degradedReason + "]" : ""}`);
  if (facts?.length) {
    console.log("\nFACTS");
    for (const f of facts) console.log(`  ${f.id.padEnd(22)} ${f.value}${f.unit ? " " + f.unit : ""}${f.approx ? " (approx)" : ""}`);
  }
  if (rows?.length && rowFmt) {
    console.log("\nROWS");
    for (const r of rows) console.log("  " + rowFmt(r));
  }
  if (flags.full === "true" && data) console.log("\nDATA\n" + JSON.stringify(data, null, 2));
}

async function main() {
  switch (cmd) {
    case "news.ingest": {
      const stats = await newsIngest(positional.length ? positional : undefined);
      console.table(stats);
      break;
    }
    case "news.rank": {
      const r = await newsRank({ hours: N("hours", 48), limit: N("limit", 20) });
      if (flags.json === "true") return out(r);
      summary(r);
      for (const n of r.data?.items ?? []) {
        console.log(`\n  [${n.rank.toFixed(2)}] ${n.sourceName}  ${new Date(n.publishedAt * 1000).toISOString().slice(5, 16)}`);
        console.log(`  ${n.title}`);
        if (n.matched.length) console.log(`  ↳ 命中 ${n.matched.join(",")}`);
      }
      break;
    }
    case "pools.list": {
      const r = await poolsList({
        chain: S("chain", DEFAULT_CHAIN),
        sort: S("sort", "tvl") as any,
        minTvl: N("minTvl"),
        minVol24h: N("minVol"),
        limit: N("limit", 20),
      });
      summary(r, r.data?.rows, (p) =>
        `${(p.baseSymbol + "/" + p.quoteSymbol).padEnd(18)} ${String(p.dex).slice(0, 20).padEnd(22)} tvl=${String(p.tvlUsd ? Math.round(p.tvlUsd).toLocaleString() : "-").padStart(12)}  vol24=${String(p.vol24hUsd ? Math.round(p.vol24hUsd).toLocaleString() : "-").padStart(12)}  apr=${p.feeAprPct?.toFixed(1) ?? "-"}`);
      break;
    }
    case "pool.detail": {
      const r = await poolDetail(S("chain", DEFAULT_CHAIN), positional[0]);
      summary(r);
      if (flags.full !== "true" && r.data) {
        const d = r.data;
        console.log(`\n${d.name}  ${d.baseSymbol}/${d.quoteSymbol}`);
        console.log(`series points: ${d.series.length}`);
      }
      break;
    }
    case "token.profile": {
      const r = await tokenProfile(S("chain", DEFAULT_CHAIN), positional[0]);
      out(r);
      break;
    }
    case "score.compute": {
      const detail = await poolDetail(S("chain", DEFAULT_CHAIN), positional[0]);
      if (!detail.ok || !detail.data) {
        console.error("cannot load pool:", detail.degradedReason);
        process.exit(1);
      }
      const r = await scoreCompute(detail.data, {
        capitalUsd: N("capital", 2000),
        riskTier: (N("risk", 2) as 1 | 2 | 3),
      });
      if (flags.json === "true") return out(r);
      const s = r.data!;
      console.log(`\n${s.pool}   ${s.grade}  ${s.total}pts  conf=${s.confidence}`);
      console.log("\n维度");
      for (const d of s.dims) console.log(`  ${d.label.padEnd(14)} ${String(d.score).padStart(3)}  ×${d.weight}  ${d.note}`);
      console.log("\n门槛");
      for (const g of s.gates) console.log(`  ${g.blocked ? (g.severity === "block" ? "✗" : "!") : "✓"} ${g.label.padEnd(12)} ${g.detail}`);
      console.log("\n理由");
      for (const x of s.reasons) console.log("  - " + x);
      if (s.risks.length) {
        console.log("\n风险");
        for (const x of s.risks) console.log("  - " + x);
      }
      break;
    }
    case "feed.build": {
      const r = await feedBuild({
        capitalUsd: N("capital", 2000),
        riskTier: (N("risk", 2) as 1 | 2 | 3),
        persist: flags["dry"] !== "true",
      });
      summary(r, r.data?.cards, (c) => `${c.kind.padEnd(5)} ${String(c.rankScore).padStart(6)}  ${c.title.slice(0, 60)}`);
      break;
    }
    case "feed.list": {
      const cards = feedList({ limit: N("limit", 30) });
      console.log(`${cards.length} cards`);
      for (const c of cards) {
        console.log(`\n[${c.kind}] ${c.title}`);
        console.log(`  ${c.subtitle}`);
        console.log(`  tags: ${c.tags.join(",")}  score: ${c.rankScore}`);
      }
      break;
    }
    default:
      console.log(`lp — DeFi LP tools

  news.ingest [sourceIds...]          抓取 RSS 源
  news.rank   --hours 48 --limit 20   按相关性排序
  pools.list  --sort vol24h --minTvl 500000
  pool.detail <address>
  token.profile <address>
  score.compute <address> --capital 2000 --risk 2
  feed.build  [--dry]                 生成 feed 卡片
  feed.list   --limit 30              读取已存卡片

  全局: --json  输出原始 JSON（agent 用）
        --full  附带完整 data`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
