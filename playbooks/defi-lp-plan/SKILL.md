---
name: defi-lp-plan
description: Executable LP plans — sizing, volatility range, V3 ticks, fee/IL scenarios, onchainos execution. Use for 生成投资计划 or sizing a position.
---

# DeFi LP Plan

A percentage range is not tradeable. On-chain liquidity is addressed by tick, so a plan without tick coordinates — aligned to the pool's tick spacing and oriented by address order — is a document, not an order.

Distinct from `defi-fact-pipeline` (builds facts) and `defi-research-report` (writes prose): this turns a scored pool into sized, tick-addressable parameters. Keep the math deterministic — users act on these numbers.

Next step: `defi-lp-position` picks the executed plan up; after it closes, `defi-lp-review` measures what it achieved and turns that into scoring weights.

## 1. Size against capacity, not the requested number

Cap deployed at TVL/20; above ~5% of TVL the slippage eats a week of fees.

Return requested and deployed separately plus a `capped` flag. Never quietly deploy less.

**One plan, one capital figure.** The economics (fees, IL, net) and the score's capacity and fit dimensions must use the number the user entered. A silent floor — `Math.max(50, capitalUsd)` — made the plan describe a $50 position while the score judged a $0.02 one: a 2500× disagreement inside one plan, surfacing as "expected net −0.27" against a position that cost 0.0195. Drop the floor, or state the substitution beside the number.

Complete when: `deployed ≤ TVL/20`, the response states whether the request was capped, and every dollar figure in one plan refers to the same position.

## 2. Range from realized volatility

Compute annualized realized vol from hourly closes (`stdev(log returns) × sqrt(24×365)`); choose the half-width whose coverage over the hold period is ≈70% and print that probability beside it.

Never offer a width without its coverage.

Complete when: every proposed width carries a coverage probability for the stated hold days.

## 3. Ticks: address order, then spacing

Read `references/v3-tick-math.md` for the formulas and pure functions before writing this code. Two rules silently corrupt a position:

- **token0/token1 are ordered by contract address, not symbol.** Comparing addresses is what decides orientation. Ordering by symbol inverts the range and the position lands backwards — and it still returns a valid-looking tick pair.
- **Ticks must be multiples of the pool's tick spacing** (0.01%→1, 0.05%→10, 0.3%→60, 1%→200). Align outward — floor the lower bound, ceil the upper — so the realized range is never narrower than requested.

Complete when: `lower < center < upper`, both ticks divide evenly by spacing, and realized half-width ≥ requested.

## 4. Economics as scenarios, not a point estimate

- `deployed × feeApr × days/365` is an **upper bound** (volume concentrates in active ticks, which pool APIs do not expose). Present labeled capture scenarios (e.g. 40 / 70 / 100%) instead of inventing a concentration multiplier the data cannot support.
- IL from the constant-product formula is a **lower bound** for concentrated positions; V3 loses more near the edges. Say so.
- Include non-fee cost as an explicit assumption, and a breakeven figure: days of fee income to cover edge IL. On X Layer gas measured **zero** (`serviceChargeUsd: 0.00`, 0 OKB across three real transactions), yet small positions still lost ~0.5–3% per round to slippage and ratio rounding. Model those fixed percentages; gas is not the expensive part. A flat $0.30 guess was ~1000× high and, consumed by a size check, would have refused every plan.
- Keep sub-cent precision. Rounding scenarios to 2 decimals turned −0.000527 into `0`, so a "net must be positive" gate passed on a loss. Carry 6 decimals.

Complete when: at least one downside scenario is shown and every bound is named as a bound.

## 5. Entry and exit must be decidable

- **Entry** derives from the price percentile within the lookback window: low → scale in over tranches; high → wait for reversion. State the rationale with the number, not advice.
- **Exit** rules must be machine-checkable: price out of range for N hours, 7d APR below X for N days, TVL drop over Y% in an hour, net PnL below −Z%. Reject "re-evaluate later" — it cannot be evaluated.

Complete when: every exit rule carries a threshold *and* a duration.

## 6. A check that cannot stop a trade is a label

Each check returns `pass`, a label, a detail string, and a **severity**: `block` or `warn`. The executor refuses `no-go` and nothing else, so severity is what gives a gate teeth.

- `block` failures → `no-go` (refused). `warn` failures → `caution` (allowed, flagged). No failures → `go`.
- Make the loss-making conditions `block`: grade D or below, expected net ≤ 0, deployed below the minimum viable size, volatility above the ceiling. A `caution` verdict is executed, so marking a negative-expectation plan `caution` is the same as approving it.
- Verified failure: with every check merely downgrading to `caution`, a 53-point D-grade plan with expected net −0.27 USD was opened for real. All the checks fired and none of them stopped anything.

Keep `warn` for what a user may accept (coverage probability, breakeven days). Gate copy that renders beside both a pass and a fail belongs to `defi-fact-pipeline` §6.

**Refusal must be overridable, and the override recorded.** Return the blocker list plus a `canForce` flag; on retry require a written reason and log it server-side. The goal is to make blind trading impossible, not trading.

**Re-judge stored plans, not only new ones.** A payload saved before severity existed carries no markers, and "no block markers" is not a pass. When the marker is absent, recompute the blockers from the stored numbers — score check, base-scenario net, deployed size — so old plans are held to the current rule instead of slipping through on their age.

Complete when: a D-grade or negative-net plan is refused with its reasons listed, a healthy plan at a sensible size is not, and a legacy payload without severity is judged by its numbers rather than waved through.

## 7. Execution handoff

Read `references/onchainos-cli.md` before writing any onchainos call: verified flag names, units, id resolution, login. None are guessable from `--help`.

These six change decisions and must survive even if the reference is skipped:

- **Login is a browser social login you cannot complete.** Surface it as a blocker; completion is `wallet status` → `loggedIn: true`, not a poll returning.
- **A V3 entry debits both tokens, even when you name one.** Build legs from `calculate-entry`'s per-token split, block when **any** leg is short, show every leg, and record the debited sum as cost (`defi-lp-position` owns the PnL consequences).
- **"No sizing" has two meanings.** All-zero legs = the wallet cannot cover the pair. `data:null` = the pool has no executable size at *any* amount; raising it will not help. Probe small **and** large, re-probe a known-good pool, then record the verdict on the plan at build time. A resolved `investmentId` is not evidence of tradability.
- **`confirming` is neither outcome, and its count is not fixed.** Exit 2 has broadcast nothing; it goes out only when re-called **with `--force`** after the user confirms. Loop until `ok` or a hard error, keyed on step index, never on message text, never forcing a first call. The position exists only when the final step returns a hash.
- **Balances are cached.** Use `--force` whenever the number decides whether to block an order or reports what was spent; reconcile with `defi positions` before calling a trade failed.
- **Approvals are unlimited by default.** Say so — the allowance exceeds the position — and offer to narrow it after a test trade.

Emit the exact command with unresolved runtime values as visible placeholders (`<投资ID>`, `<钱包地址>`). A guessed value is the failure mode.

Login creates a server-side wallet that can sign, which raises the bar rather than lowering it: keep generating calldata for the user to confirm, and automate signing only on explicit authorization *and* with a per-transaction cap — a service that can sign is a service that can drain.

**Freeze everything the executor reads into the saved plan** — both token addresses, the payment side's decimals, the resolved investment id and its tradability verdict, not ticks alone. What the build step knew must be stored, not re-derived.

Complete when: the command carries real ticks and token addresses, every unknown is a visible placeholder, every deposit leg is shown with its balance, the funded chain is stated, the response says nothing was signed, and a stored plan executes without re-fetching.

## Honest limit

Coverage probability is driftless-lognormal: it overstates staying in range because it ignores jumps and fat tails. The two economics bounds in §4 are the other two, and each is named where it is computed.

## Pitfalls

Steps 1–7 state their failure modes inline. Mechanics that look like bugs but are CLI behaviour — login, `confirming`, caching, decimals, id resolution — are indexed in `references/onchainos-cli.md` § Symptom index.

| Symptom | Cause | Fix |
|---|---|---|
| Trade lost money despite the plan reading `caution` | checks only downgrade; the executor refuses `no-go` alone | give loss conditions `block` severity |
| Expected net describes a different size than the position | plan used a floored capital, score used the input | one capital figure per plan |
| Every plan refused after a size check was added | gas assumption ~1000× high for the chain | measure gas; model slippage instead |
| "Net must be positive" passes on a loss | scenarios rounded to 2 decimals | 6 decimals for money |
| A legacy plan executes though it fails today's rules | no severity markers on pre-existing payloads | recompute blockers from stored numbers |
| Small position bleeds a few % per round | fixed slippage/rounding cost, not gas | size floor; say the cost before recommending a move |
