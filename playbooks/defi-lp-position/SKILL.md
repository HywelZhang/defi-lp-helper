---
name: defi-lp-position
description: Track, monitor, rebalance and close LP positions — real cost basis, realized vs unrealized PnL, append-only log, V3 withdraw, range moves, fee collect, out-of-range alerts, unattended automation.
---

# DeFi LP Position

The chain is the source of truth for *current* state. Ours owns intent: which plan opened it, what was paid, why it closed — a page that only mirrors the chain cannot show PnL or explain why.

Distinct from `defi-lp-plan` (sizes and enters), `defi-fact-pipeline` (builds the feed), `defi-lp-review` (judges a finished trade): exit has its own CLI surface, state model and arithmetic.

## 1. Discover, then detail — two calls

`defi positions --address <a> --chains <id>` returns a protocol overview with `analysisPlatformId` and `investmentCount`. It does **not** carry `tokenId`. `defi position-detail --address <a> --chain <c> --platform-id <id>` does.

Run the overview to learn which platform ids hold something, then detail per platform: guessing an id wastes a round trip, and skipping detail leaves no `tokenId`, which withdraw needs. Skip `investmentCount: 0`. Treat a per-platform failure as partial: report which failed rather than returning an empty portfolio, which reads as "no positions".

Complete when: every platform with holdings was drilled and each V3 position has a `tokenId`.

## 2. Identity is the tuple, not the pool

Key a position on `(chain, address, investmentId, tokenId)`. One wallet can hold two ranges in the same pool, so `investmentId` alone collides and the pool address alone collides more. `tokenId` exists only after the chain indexes the NFT: re-sync after a deposit before linking to its plan, since the first sync may still return the old set.

**A rebalance breaks the tuple on purpose** — re-entering mints a new NFT, so a tuple key inserts a second row. Keep the origin row's id as the position's identity across a rebuild (§7).

Complete when: re-running sync twice creates no duplicate rows.

## 3. Read amounts at the position level

Token amounts sit on the **position**, not the holding wrapper: the wrapper's `assetsTokenList` is empty for V3 pools while `positionList[i].assetsTokenList` carries the real split — reading the wrapper yields a value with zero tokens, which looks like missing upstream data. `references/position-cli.md` has the verified shape, fee/range paths and an extractor skeleton.

Complete when: a position's token amounts sum to roughly its `totalValue`.

## 4. Cost basis is what was spent, not what was requested

A plan stores the size the user *asked for*; a V3 entry can deploy far less (a plan requesting $50 deployed 0.945586, reporting −98% on a flat position). Store the real spend at open and never PnL against the requested figure. Sum the entry legs **in USD**, each by its own unit price: raw quantities mix units, and a stablecoin under $1 overstates cost. Same trap on exit — resetting `value_usd = 0` makes every closed row read −100%; store `proceeds` and compute against that.

Complete when: a freshly opened position's cost equals the debited value in USD within rounding, and a closed position shows its realized result rather than −100%.

## 5. Realized and unrealized are different formulas

- open: `value + uninvested cash − cost`
- closed: `proceeds − cost`

Uninvested cash matters after a rebalance: the pool never takes both legs in the offered ratio, so capital stays in the wallet — ignoring it reported −0.91% on a position down 0.16%. Accumulate it (overwriting drops earlier leftovers) and derive it from the chain, not our own lagging row. Summary and rows must share one basis. Keep closed rows visible, or a summary over open rows reads 0 after a full exit — right for exposure, wrong for performance.

Complete when: the closed row's PnL matches the wallet delta for that trade.

## 6. Append-only action log, and why the position opened

Record `open` / `withdraw` / `collect` / `range_adjust` events with amount, tokens, tx hashes and a note. Never update in place: a rewriteable log is not an audit trail.

Link by **storing the resolved investment id on the plan** at execution time and matching on it — inferring from recency or pool name mislabels history (our own trade read as "discovered on-chain" because the link ran before the id was stored). Repair by matching `investmentId`, then fix the write path; on a late link, correct the existing `open` event rather than appending a second.

To show *why* it was opened, join the plan's `chain` + pool `address` to the research subject id (`chain:address`).

Complete when: every position opened by the system shows its plan id and no row claims to be foreign when it is not.

## 7. Exit is generated, not signed

`defi withdraw` and `defi collect` return unsigned calldata like entry; signing stays with `contract-call` and the human confirming it.

- V3 requires `--token-id`; without it the call targets the wrong position or fails.
- Pass `--platform-id` so the CLI re-reads detail; amounts move with the pool, so stale numbers revert.
- Label steps by selector: `0x095ea7b3` ERC20 approve, `0xa22cb465` ERC721 `setApprovalForAll`. A V3 exit is NFT-approve then reduce-liquidity, so "approve" alone hides an NFT delegation.

Complete when: the sequence is token-id-scoped, each step is labeled by what it does, and nothing was signed by the generator.

### Rebalancing a range

No atomic range change exists: the CLI has no increase/decrease and a V3 range is fixed at mint. A rebalance is withdraw-then-re-enter as two separately confirmed batches, so failure leaves capital loose rather than half-invested. Persist target ticks and released legs **before** generating the withdraw, recompute ticks from the current price, and merge the rebuilt row into the origin (§2) on **every** sync since indexing lags. `references/position-cli.md` holds the merge query, delete-before-relink order and leftover-cash formula.

**This step can destroy data: `investment_id` is not unique.** One pool can hold several positions sharing it, so "the newest other open row in this pool" is as likely an unrelated position as the rebuild — and merging deletes what it matches. A merge bounded only by `investment_id` ate a live $0.90 position while rebalancing a $0.02 one. Require both:

- `opened_at >= intent.startedAt` — the rebuild cannot predate the rebalance that asked for it
- the candidate carries no *different* plan id — the rebuild row is always inserted unplanned

Before any such delete, confirm the key identifies exactly one intended row; a bare `investment_id` never does. Cost is ~0.5–0.9% per round sub-dollar and ~2.7% near $0.02 — say so before recommending a rebalance on a small position.

Complete when: the exit and re-entry show as one position with one continuous timeline, the cost basis still traces to the original entry, and no other position in the same pool lost its row.

## 8. Never assume how many confirmations a run needs

`confirming` (exit 2, nothing broadcast) is raised at the CLI's discretion, not once per step — the same integration needed three calls for a 3-step entry and one for a 2-step exit. Drive a bounded loop until ok or a hard error, keying continue-state on step index and never deduping by message text; a flow expecting exactly one extra confirmation hangs on one shape and wastes a round trip on the other. `references/position-cli.md` records the measured call shapes.

Complete when: the loop terminates on its own for both shapes and a replay of the same token is refused.

## 9. Verify closure on both sides, and believe neither immediately

`ok: true` is not proof, and an unchanged balance is not proof of failure: after a confirmed withdraw the balance total stayed stale for ~20 s while the position list emptied at once. Confirm with both — holding list empties **and** the balance lands — and reconcile against the position list rather than the cached total. `references/position-cli.md` has the measured lag.

Complete when: the position list no longer contains it and the wallet delta matches the proceeds within rounding.

## 10. Monitoring reads state; it does not act

Read `references/monitoring.md` first: price derivation, clamp, alert keys, digest columns. Two rules decide the outcome:

- **The CLI does not report range status.** `positionStatus` reads `ACTIVE` in range or not, so a check built on it never fires. Derive price from the token split: in range a V3 position holds both tokens, out of range one.
- **Do not solve that price by bisection.** The ratio diverges at the upper edge, so a bracket seeded at `f(upper)` is `Infinity` and a non-finite guard rejects every healthy position — all rows read `unknown`, nothing errors. Solve the quadratic.

Dedupe alerts on position + state + day via a unique constraint, or an hourly job repeats one warning 24 times and trains the user to ignore all of them. Supply every NOT NULL column on the digest insert; a silently failed insert is a summary that never appears.

Detection is not action. Before adding any automatic move, read `references/automation.md`: policy declared on the plan, seven gates in authority order, dry-run as the default, and the scheduling rule that keeps decisions on fresh data. Recentring and auto-exit carry different risk — do not treat one as the other. Say "monitoring only" when that is what exists, and where alerts reach a human.

Complete when: an out-of-band position raises a danger row, a healthy one raises none, and a same-day re-run adds no duplicate.

## Honest limits

- Cost basis is our own snapshot: a position first seen on-chain has no true entry price — mark it externally opened rather than inventing one.
- Unclaimed fees are often zero right after opening; a zero fee row is expected, not a sync bug.
- Out-of-range detection needs a price the API does not give; `references/monitoring.md` derives it and names where that breaks down.

## Pitfalls

Steps 1–10 name their failure modes inline. `references/position-cli.md` has the verified payload shapes and a symptom index — start there when a number looks off. `references/monitoring.md` covers range classification, alert dedupe, the digest and where alerts are delivered. `references/automation.md` covers anything that moves money unattended.
