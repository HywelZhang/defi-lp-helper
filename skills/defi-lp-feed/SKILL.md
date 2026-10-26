---
name: defi-lp-feed
description: Build and interpret the LP opportunity feed — rank pools and news into deduped cards with sourced numbers. Use when asked what LP opportunities exist, what is worth watching on Base, or when a feed card needs explaining.
---

# DeFi LP Feed

Produce a ranked, deduplicated stream of LP pool cards and news cards where **every number traces to a tool output** and every recommendation states its gates.

## Non-negotiables

- Never state a number that is not present in a tool result. If a field is missing, write `—` and lower the confidence.
- Pool score comes from `score.compute`. Do not re-score by feel.
- If a card's `confidence < 0.8`, the caveat must appear in the same sentence as the recommendation.
- No recommendation for a pool that hit a `severity: "block"` gate. Say which gate.

## Procedure

1. `lp pools.list --sort vol24h --minTvl 250000 --limit 60 --json` — candidate universe for Base.
2. `lp score.compute <address> --capital <USD> --risk <1|2|3> --json` per candidate. Discard grade `F`.
3. `lp news.ingest` then `lp news.rank --hours 72 --limit 20 --json`.
4. `lp feed.build --json` — persists cards; dedupe is handled there.
5. Read `lp feed.list --limit 40` for the rendered set.

## Ranking, as implemented

News relevance is deterministic:

```
relevance = min(0.9, 0.45 × watchlist_hits)
          + 0.18 if LP/收益 vocabulary in title
          + 0.20 if 风险词汇 (hack/exploit/depeg/rug/halt)
          + 0.08 if 监管词汇 (sec/etf/fed)
rank      = (0.25 + relevance) × freshness × source_weight
freshness = 1 / (age_hours + 2)^0.55
```

Off-topic items (big-tech consumer news) are dropped before ranking. Pool cards rank by `score + min(12, log10(vol24h) × 2)`.

## Dedupe rules (why the feed is not repetitive)

- Same asset pair collapses to one card, keeping the highest-ranked; the rest become `siblingTiers` on the detail view. A pair across 4 fee tiers is 4 products but 1 feed card.
- Cross-source duplicates group by normalized-title fingerprint; the extra outlets become `另 N 源报道`, not extra cards.
- Pool cards recompute with a score in the dedupe key, so a materially changed score produces a new card rather than mutating history.

## Gates (mirror of `core/tools/score.ts`)

| Gate | Threshold | Severity |
|---|---|---|
| TVL | ≥ $200k | block |
| 24h volume | ≥ $50k | block |
| Turnover (vol/TVL) | ≥ 0.05 | block |
| Pool age | ≥ 48h | warn |
| Capacity (TVL / capital) | ≥ 20× | block |
| Fee tier | ≤ 5% | block |
| Fee APR | ≤ 300% | warn (刷量嫌疑) |

Fee APR is an **upper-bound estimate**: 24h volume × headline tier / TVL × 365. V3 volume concentrates in active ticks, so real fees are usually lower. Always label it 估算.

## Card output contract

Pool card: 标题 / dex / 池龄 / TVL / 24h vol / fee APR（估算）/ 换手 / 24h 涨跌 / 一句带数字理由 / 门槛状态 / 置信度.
News card: 标题 / 来源 / 时间 / 命中 token 或赛道标签 / 一句摘要 / 原文链接 / AI 解读入口.

## When not to recommend

- Pool age < 48h with TVL still climbing (fake depth from launch incentives).
- Fee APR > 300% (almost always wash volume; the number is the tell, not a feature).
- Single-asset exposure dressed as a pair (check both sides are real tokens with independent flow).
- Stable pair below ~8% APR: gas and management cost likely exceed the yield.
- News with no identifiable token or protocol entity: it is not actionable for a position.
