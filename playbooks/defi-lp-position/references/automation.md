# Unattended Automation

Read this when an automation will move money with no human confirming each action: a recentring rule, an auto-exit, anything that spends on a schedule. `defi-lp-position` §10 states that detection is not action; this file is how action is made safe.

The procedure that held up is: **a policy declared at plan time, executed by a runner with seven gates, with every decision auditable.** Each rule below came from a failure observed while building it.

## Where the policy lives

On the **plan payload**, declared when the plan is created — "when should this position be re-centred" is part of the investment decision, so it belongs beside the range and the exit conditions where the user sees what they are agreeing to, not in an ops screen.

Normalise every field rather than rejecting: a plan with a nonsensical tolerance should still save, just not be automatable. Two contradictions to resolve explicitly, or the switch lies:

- `enabled: true` with `mode: "off"` → treat the switch as master and force the mode on
- `enabled: false` → force the mode off

Off unless the user ticked it. A plan created after the feature ships must not silently inherit the right to move money.

Fields that earned their place (recentre form):

| Field | Purpose | Default |
|---|---|---|
| `tolerancePct` | deadband around the band centre | 12 |
| `halfWidthPct` | width to rebuild at | 10 |
| `maxPerDay` | per-position action cap | 2 |
| `minValueUsd` | size floor | 20 |

## Seven gates, in authority order

1. **Global kill switch**, default off, persisted (a `settings` row), visible in the UI with its current state and last action. Nothing runs while it is off, whatever any plan says.
2. **Per-plan opt-in** — the policy above.
3. **Deadband** — with `bandPos` in `[0,1]` across the band, act when `|bandPos − 0.5| × 2 > tolerancePct/100`. Recentring on every tick burns fees on noise.
4. **Daily cap** — count successes from the audit log, not from separate state, so the limit and the trail cannot disagree about how many times something happened.
5. **Size floor** — verified cost is ~0.5–0.9% per round at $0.94 and ~2.7% near $0.02; a position where one round exceeds a day of fees should not be automated at all.
6. **Cost check** — skip when the round trip exceeds a set share of expected daily fees.
7. **No blind retry** — a failed action stops that position; it does not hammer.

Out-of-range is always actionable regardless of the deadband: the position has stopped earning fees entirely, which is the condition the rule exists to fix.

## The decision must be pure

Split `decide(positionState, policy, context) → {action, reason}` from the executor. The rules then run without a chain, a clock or real money — verified by exercising 12 scenarios in one pass: centred, inside deadband, past deadband, out both ways, daily cap reached, below size floor, pending intent, unreadable position.

Without that split, "does an out-of-range position actually trigger" cannot be answered without a live breakeven position, and the rule stays unverified while looking implemented.

Return `skip` with `expected: true` for the ordinary nothing-to-do cases, and `blocked` for a real impediment. The distinction drives notification (§ Auditing), not just wording.

## A pending intent blocks

If a rebalance intent exists unfinished, refuse: the capital may be loose in the wallet, and starting a second move strands it further. This is `blocked`, not `skip`.

## Reuse the money-moving path

Call the same prepare/confirm functions a human uses. A second, "automated" implementation of withdraw-then-re-enter is a place for the two to diverge, and the divergence surfaces only when it costs money.

The confirmation count is not fixed (`defi-lp-position` §8): a bounded loop answering `confirming` by re-calling the same token with the force flag is what makes an unattended run possible at all. Retry twice at most.

A failure **after** the withdraw is not the same as a failure before it: capital is now in the wallet. Flag that outcome explicitly and say so in the notification, or the user believes the position still exists.

## Scheduling: chain it, do not give it its own timer

Run automation inside the monitor job, after the checks are written, rather than on an independent interval. Two timers eventually let one read a band position from yesterday, and the consequence here is moving real money on stale data.

On boot, skip if a successful action is recorded within the last ~30 minutes. A crash loop otherwise re-triggers automation on every restart, and the position is re-centred repeatedly with no human ever seeing it happen.

## The API defaults to dry run

Accept `dryRun` and treat **its absence as true**; a caller must pass `dryRun: false` to trade. An accidentally-invoked endpoint must not move funds.

Dry run decides everything and reports what it would do, including per-position `would rebalance` and why. It is also the only responsible way to demonstrate the feature: the first real run should be something the operator asked for.

## Auditing

Notify on: an action taken, a failure (with the partial-capital caveat), and a blocked state.

Do **not** notify on expected skips. An hourly inbox row saying "still centred" trains the user to ignore the inbox, which is how the one alert that matters gets missed. Idempotent write, severity/read separation and pruning are in `monitoring.md` § Inbox.

Every skip that was recorded by hand while testing was, in fact, a real gate doing its job — read a silent dry run as "the gates are working" only after confirming which gate fired and why.

## The kill switch must not live in a hidden panel

Verified failure: the switch was placed inside the alerts section, which is `hidden` when there are no alerts — so the one moment the user needs to confirm whether automation is running is the moment the control is unreachable. Give it its own always-visible panel showing on/off, the last action time, and a dry-run button.

Turning it **on** warrants a confirmation naming the consequence (moves money without further confirmation). Turning it **off** never does: stopping should always be frictionless.

## What this does not include

Auto-exit (closing a position because it should be abandoned) is a different risk from recentring. Recentring's worst case is a position at a bad range; auto-exit's worst case is selling something that would have recovered. Do not extend this file to it without an explicit decision and its own gates.

## Symptom index

| Symptom | Cause | Fix |
|---|---|---|
| Automation never runs | policy exists, no scheduler calls it; or the global switch is off | chain it to the monitor job; show switch state |
| Positions re-centred minutes after every restart | boot pass acts immediately | skip when an action is within ~30 min |
| Same position moved repeatedly in one day | cap held in memory or reset on restart | count successes from the audit log |
| Rules untested yet "implemented" | decision inlined in the I/O loop | extract a pure decide function |
| User cannot find the on/off state | switch inside a panel that hides when empty | dedicated always-visible panel |
| Failed run leaves a half-built position | withdraw succeeded, rebuild did not | flag partial, notify with the caveat, stop |
| Automation acted on a stale band position | separate timer from monitoring | run after the check writes |
