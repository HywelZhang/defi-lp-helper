---
name: defi-research-report
description: Auditable AI research reports from tool evidence — evidence bundle, number whitelist, citation refs, downgrade instead of repair.
---

# DeFi Research Report

Turn deterministic tool output into a report a human can audit. The model explains; it never supplies a number.

Distinct from `defi-fact-pipeline`: that skill builds the feed and the facts. This one consumes them and holds the line on what the model may say.

## 1. The evidence bundle is the only model input

Nothing reaches the prompt that is not in the bundle.

- Emit an `allowedNumbers` whitelist alongside the facts: every metric, plus the derived tables the report is expected to cite (volatility, range coverage, IL ladder, position caps), plus recent chart prices.
- Harvest numbers from strings with magnitude words expanded — `404M`, `4.04亿`, `$77.23M` all normalize to the same value. Harvesting the literal text alone makes correct restatements look invented.
- Name facts in plain language for display and expose section refs (`pool.tvl`, `score.dims`, `risk.vol30dPct`) for citation.

Complete when: every number the report may cite appears in the whitelist, and the bundle reports how many are allowed.

## 2. Assemble the prompt from the versioned skill file

The in-app report generator and the chat agent read the same `SKILL.md` as the system prompt. One file owns the judgment criteria, so page and chat cannot drift. (How a chat turn is grounded in live tables, and how its prose is rendered safely, is `ai-chat-surface`; this file still owns the criteria both consume.)

Version that file by content hash and fold the hash into the cache key. Editing the criteria must invalidate old reports.

Complete when: changing the skill file changes the cache key.

## 3. Disable reasoning before asking for JSON

A reasoning model spends completion tokens on hidden `reasoning_content` first. With a bounded `max_tokens` it hits `finish_reason: length` with **empty `content`** — a silent, fully-billed failure that looks like an empty answer.

- Set the thinking/reasoning switch off (`thinking: {type:"disabled"}` or the provider's equivalent) whenever `response_format` is JSON.
- Treat empty content plus `finish_reason: length` as an error naming the reasoning tokens consumed. Never pass it on as "the model returned nothing".
- For JSON, raising the budget is not the fix: reasoning scales with the task and consumes it again — switch it off instead. Free-form chat is the opposite branch: there deliberation is the product, so thinking stays on and the cap must pay for it, with one retry without thinking on truncation. `ai-chat-surface` §2 owns that branch.

Complete when: a JSON call returns non-empty content with reasoning tokens at zero.

## 4. Validator: three gates, each can only remove

Schema, numbers, refs. A failing claim is dropped; nothing is rewritten by the validator.

- **Numbers** — compare against the whitelist with unit normalization (k/m/b/万/亿 and order-of-magnitude shifts). Literal comparison rejects a correct restatement and shreds a good report.
- **Refs** — build the whitelist per subject kind. A news bundle has no `pool.tvl`, but the numbers really live under related pools and the model will write `pool.tvl`; accept those aliases. A whitelist built only from that subject's own fields discards true claims.
- Exempt small integers (≤12) as counts, and require a ref only above a short length so a one-clause fact is not rejected for brevity.
- Keep a deterministic section that the model may explain but not alter: scores, gate verdicts, PnL. State in the output contract that those values are quoted, not recomputed.

Complete when: a golden report passes at 1.0 and a seeded fabricated number is dropped with its code recorded.

## 5. Downgrade, never repair

On failure, render the deterministic facts and scores, mark the AI section degraded, and name the failing check. Do not retry with a "fix this" prompt — that launders the same invention and hides the evidence gap.

Store failures separately for debugging; never serve them as reports.

Complete when: the failure path shows facts plus an explicit degraded note and no prose from the rejected output.

## 6. Long model calls need a job, not a held request

A 15–30 s generation inside one HTTP request trips proxy timeouts and reads as a broken page.

Return a job id (202), poll a light status endpoint that reports a coarse phase, and fetch the result once. Do not poll with the full payload attached.

Complete when: the UI shows progress and finishes without any request outliving the timeout.

## 7. Cache on content, not on time

`key = hash(subject | evidence values + score | skill version | user parameters)`. Reuse within a TTL so a reload does not re-bill.

Complete when: a second request for the same subject returns the cached report with a flag the UI can show.

## Honest limit

The validator catches numbers that do not exist, not numbers that are true but misread. Only tracking recommendations forward against realized outcomes can test the interpretation. Say so; never present validation as evidence the advice is good.

## Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Empty model output, tokens billed | reasoning consumed the budget | disable thinking for JSON |
| Correct restatement rejected as invented | literal number comparison | unit-normalize before comparing |
| Every report for one subject degrades as "not found" | card/display id passed where the evidence layer queries subject id | pass the subject id (e.g. the `refId`), not the card id |
| News reports discard true claims | ref whitelist built only from that subject's fields | accept cross-section alias refs |
| Report still wrong after a retry | repairing with a second pass | downgrade and show facts |
| Drawer looks hung for 30 s | generation held in one request | job + poll |
