---
name: defi-fact-pipeline
description: Build, verify or audit a DeFi LP flow — traceable numbers, domain-gated and deduped cards, ranked boards, chain config, local run and handover, requirement audit.
---

# DeFi Fact Pipeline

Build DeFi flows where every number a human or model reads comes from a tool result, and the stream does not repeat.

Project-specific thresholds and card contracts live with the project; this skill holds the rules that hold regardless of the numbers.

Next steps: `defi-research-report` (evidence, validator, downgrade); `defi-lp-plan` (sizing, ranges, ticks, execution); `defi-lp-position` (state, cost basis, PnL, exit); `defi-lp-review` (outcomes; the style gate); `ai-chat-surface` (chat: grounding, prose budget, rendering, SSE streaming, skills, sessions).

## Before building

Answer the approach question first. This user reviews plans before implementation and repeats "how will you implement X" when the answer is missing — reply with the approach and its decision points, then wait. Do not keep coding through that question.

## 0. One network, three spellings

Each integration names a chain differently, and the names diverge exactly where a naive pass-through would otherwise work. Keep one table — internal key → data-source id → CLI name → chain id — and pass the internal key through the app, converting only at the boundary.

| Internal | GeckoTerminal path | `onchainos --chain` | Id |
|---|---|---|---|
| `x-layer` | `x-layer` | `xlayer` | 196 |
| `base` | `base` | `base` | 8453 |
| `ethereum` | `eth` | `ethereum` | 1 |

The failure is asymmetric: `x-layer` reaching the CLI gives `unsupported chain`; `xlayer` reaching the data source 404s as "network not found" — both read as unsupported rather than misspelled.

Switching the default chain moves the candidate universe: one chain may offer a couple dozen pools above $50k at single-digit fee APR, another hundreds at double-digit. Re-measure pool count and APR distribution, and say the economics changed instead of re-serving the same UI.

Complete when: no chain string is hardcoded outside that table (a grep for the old chain's literal returns only the table), and the report after a switch states how the pool count and APR range changed.

## 1. Tool envelope

Every tool returns one shape; the CLI, the HTTP layer, and the model all read it:

```
{ ok, data, facts: [{id,label,value,unit,ts,source,approx}], sources, degraded, degradedReason, tookMs, version }
```

Register a fact with a stable id where the number is produced. Anything the model writes must cite a fact id; a number with no fact behind it is deleted, not softened.

Carry the failure reason through every hop. An HTTP helper that throws `400 /api/x` on non-2xx discards the reason the server wrote, so distinct failures arrive as one bare status and read as a broken server. Read the body on both paths, surface `error`/`degradedReason`, keep the status for branching.

An intermediate state needing one more human step is not an error: return 2xx plus an explicit flag, or the client renders a normal prompt as a failure and someone debugs working code.

Complete when: `facts[]` values match `data`, `degraded` is false on a healthy upstream, and a deliberately failing call reaches the caller with its reason text, not a status code alone.

## 2. Ingest news with a domain gate

Sources publish general tech news, so a feed ranked on freshness alone fills with consumer-AI stories. Gate before ranking:

- Keep an item only if it matches domain vocabulary (crypto, DeFi, DEX, LP, stablecoin, regulation), misses the off-topic list, and clears a minimum signal fraction. The project picks the cutoff; require one, applied before ranking, and report how many items it dropped.
- Extract entities with alias mapping, not only cashtags: articles write "bitcoin", not "$BTC". Map word → ticker for majors and protocol names, then union with `$TICKER` matches.
- Backfill stored rows after changing extraction, or the rule only affects future items.
- Probe a new source for a nonzero parsed item count, not HTTP 200: parked pages and moved paths answer 200 with an empty body, so a status-only source list silently contributes nothing.

Complete when: a rank call reports a nonzero filtered count and every top feed item names a token or protocol. If watchlist hits are 0 while headlines name majors, the alias table is missing terms — that silence is the signal.

## 3. Dedupe on the product, not the row

- News: group by normalized-title fingerprint (lowercase, drop stopwords, sort tokens). One primary card per group; other outlets become "also covered by N sources".
- Pools: collapse a pair to one card regardless of fee tier, keeping the highest ranked and exposing the rest as a sibling-tier count. Four fee tiers of one pair is one story, not four cards.
- Put the score in the pool dedupe key so a materially changed score creates a new card instead of mutating history.
- Persisted cards outlive their chain by design. Carry the chain on every card and filter reads by the active chain; otherwise a switch interleaves two networks and the page looks duplicated rather than migrated.

Complete when: a rebuild lowers card count without losing a distinct pair, no two visible cards share a pair, and after a chain switch every visible pool card names the new chain — check the read path: old rows are still valid in storage.

## 4. Ranked boards

A board is a filter **plus a reason to care**: one question answered, one sort, one line saying why each row is on it. Eight ways to sort one list is one board with eight labels.

- **Fetch once, partition many.** Boards come from one or two upstream pulls split several ways. One request per board multiplies a rate-limited source into a broken page.
- Each board re-scores with its own risk tier: "best stablecoin pool" and "best long-tail pool" do not share a volatility tolerance.
- **Personalisation passes the same gate as the style profile** (`defi-lp-review` §4). A profile built on too few observations or too short a window must leave ordering untouched, and the page must name why. Applying an unreliable profile's `avoid` list would blacklist the asset class the user actually trades, on the evidence of a single loss.
- When it does apply, annotate the row ("已持有 USDG", "历史亏损于 X") so a reshuffle is explainable; unexplained reordering reads as a bug.
- Verify the link out end to end. A board whose "查看" button navigates to a URL param the target page never reads is a dead control that looks live.

Complete when: no two boards differ only by sort order, each pool's board membership states its reason in numbers, and an untrusted profile leaves every board's order byte-identical.

## 5. Label estimates

Fee APR from volume is an upper bound: `vol24h × feeTier / TVL × 365`. Concentrated-liquidity volume sits in active ticks, so realized fees are lower. Mark the fact `approx` and say 估算 in copy.

The fee tier is often not a field: pool APIs expose it only as a name suffix (`WETH / USDC 0.3%`). Parse it before computing APR; when absent set APR null and lower confidence rather than zero, which ranks the pool as worthless.

Complete when: every derived number in the UI carries `approx` or an explicit 估算 label.

## 6. Gate copy must read correctly on both paths

Gate detail strings render beside both pass and fail states. Write "actual (threshold)" — never "only $X" or "> limit". A passing gate printed as "TVL is only $154M" contradicts its own ✓.

Complete when: no passing gate's detail contains a judgement word, and no `✓` row states a violation.

## 7. Run and verify locally

Read `references/local-run-and-handover.md` before restarting a server, verifying a module, or scheduling a job. Three failures are invisible to a smoke test: `pkill -f` killing its own shell, `node --check` passing on a `.ts` that throws on load, and `.unref()` on a Promise killing the process on the first tick.

A rendered page is not a usable page: a screenshot shows only the visible slice, so content clipped below the fold looks fine in it. Measure the scroll container (`scrollHeight > clientHeight`, `scrollTop` moves) and cap any list that grows with usage, or one card outgrows the screen and buries its own buttons.

**Auditing a build against stated requirements is the same job: verify by source, never recall.** A capability exists only if a module imports and calls it, a nav entry with `href="#"` is an unimplemented page, a rendered `<button>` with no `id`/`data-act`/listener is decoration, and a table with readers but no writer is not a feature. Read the audit procedure in `references/local-run-and-handover.md` § Auditing a build before reporting a flow as finished.

Complete when: every capability you claim names the module that calls it, every interactive control names its binding, every write-shaped control names its INSERT, and anything absent is stated as absent rather than omitted.

## 8. Hand over a reachable URL

A 200 on `localhost` is not a delivery; an unreachable link is unfinished work.

Read `references/local-run-and-handover.md` for the reachability test, the tunnel command, and the layering rule (a dead tunnel looks like a broken app). Gate **before** handing over — a tunnel publishes whatever the app serves — and state the link's lifetime and auth posture in the same message.

Complete when: the public URL returns health, the page renders in a screenshot taken from that URL, and the message states the link's lifetime and whether it is protected.

## Pitfalls

Steps 1–7 name their failure modes inline; this indexes the pipeline-level symptoms that are easy to misdiagnose. Run, layout and handover traps live in `references/local-run-and-handover.md`, auth and spend traps in `references/auth-gate.md` — read the file that owns the stage you are debugging rather than looking for the symptom here.

| Symptom | Cause | Fix |
|---|---|---|
| `--chain x-layer` → `unsupported chain` | CLI spelling differs from the data source's | keep one chain table, map at the boundary |
| APR looks impossibly good | volume-based upper bound | label 估算, distrust above 300% |
| Feed renders but every card is off-domain | gate applied after ranking, or absent | gate before ranking; report the dropped count |
| Pool page looks duplicated after a chain switch | reads not filtered by the active chain | carry the chain on every card, filter on read |
| Every board is the same list in a different order | boards differ only by sort | give each board its own risk tier and reason |
| A ✓ gate states a violation | detail string written for the fail path | write "actual (threshold)" |
| An interactive control does nothing | markup only — no `id`, `data-act` or listener | bind it, or remove the control |
| 关注/收藏 saves nothing | table has readers, no write route | add the endpoint and the INSERT behind it |
