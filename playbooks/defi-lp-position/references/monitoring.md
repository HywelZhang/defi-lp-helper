# Monitoring Open Positions

Read this when implementing the periodic check in `defi-lp-position` §10: deriving whether a position is still in range, raising alerts, and writing the daily digest. The skill's step holds the rules that change the outcome; this file holds the math, the trap, and the exact columns.

## The CLI will not tell you

`positionStatus` from `defi position-detail` is `ACTIVE` for every open position, in range or not. There is no `IN RANGE` / `OUT OF RANGE` field — a note claiming otherwise is wrong. A check built on that field is a monitor that can never fire.

The available signal is the token split: in range a V3 position holds **both** tokens; out of range it holds **one**, entirely.

## Price from amounts (in range)

With liquidity `L`, band `[pa, pb]`, and `s = √p`, `sa = √pa`, `sb = √pb`:

```
base  = L · (1/s − 1/sb)
quote = L · (s − sa)
```

Dividing cancels `L` and leaves the ratio as a function of price alone:

```
r = quote / base = (s − sa) · s · sb / (sb − s)
```

Rearranged into a quadratic in `s`:

```
sb·s² + (r − sb·sa)·s − r·sb = 0
```

Since `a = sb > 0` and `c = −r·sb < 0`, the discriminant exceeds `b²`, so this root is always positive:

```
s = (−b + √(b² − 4ac)) / (2a),   p = s²
```

Clamp `p` to `[pa, pb]`: outside the band the derivation no longer holds, and returning a fabricated interior price would hide the break.

### Why not bisection

The ratio is monotonic but **diverges at the upper edge** (`sb − s → 0` gives `r → ∞`). A bisection that seeds `lo = pa`, `hi = pb`, evaluates both ends, and rejects the interval when an endpoint is non-finite therefore rejects *every healthy position*:

```ts
// verified failure
const fHi = f(upper);                    // Infinity — normal, not degenerate
if (!Number.isFinite(fHi)) return null;  // → state "unknown" for all positions
```

The symptom was not an error: every position reported `unknown`, no alerts fired, and the page showed "区间未知" beside a band that was plainly fine. Solve the quadratic instead; the divergence becomes irrelevant.

### Orientation check

`rangeInfo.lowerPrice/upperPrice` are **token1 per token0**; the returned token list is ordered base then quote. Those two orders agree only when token0 happens to be the base symbol. Confirm before trusting a result:

- read the band's units (`range.text` reads like `0.97093 - 1.03107 USDG per USDT`)
- sanity-check the derived price against something known — a stablecoin band should land near 1

Verified: base USDT 0.478988, quote USDG 0.422092, band 0.926542–1.087842 → derived **0.998829**, correct for a stable pair.

## Classification

```
bandPos = (p − pa) / (pb − pa)
```

| Condition | State | Level |
|---|---|---|
| one side holds ~0 | `out_below` / `out_above` | danger |
| `bandPos < 0.10` or `> 0.90` | `near_lower` / `near_upper` | warn |
| otherwise | `in` | — |
| band or amounts unusable | `unknown` | none |

Decide "one side is empty" relatively — a dust balance from rounding must not read as in-range. Treating any nonzero as two-sided masks a real exit.

## Alert keys

```ts
oor:${positionId}:${state}:${day}      // danger, once per direction per day
near:${positionId}:${state}:${day}     // warn
dd:${positionId}:${floor(pnlPct/5)*5}:${day}   // warn/danger by depth
fee:${positionId}:${day}               // info, fees ≥1% of cost
```

`UNIQUE(dedupe_key)` on the alerts table makes the insert itself the guard: an hourly job then emits one row per condition per day instead of 24.

A state change is a new key by construction, so "went from near-edge to out-of-range" reports even though the day is the same.

## Daily digest

Aggregate the latest check per position, then insert into the review table. Every column below is `NOT NULL` with no default, and omitting one fails the insert **without surfacing anywhere** — the daily summary simply never appears:

```
id, kind='daily', subject_id, period_start, period_end,
status='facts', facts, created_at, evidence_version, skill_version
```

Use `status='facts'` so a numbers-only row is never mistaken for a model-written review that carries judgement. `subject_id` is the chain: the row summarises every position on it, not one.

Dedupe by `(kind, period_start)` so a scheduler ticked more often than daily cannot double-write.

## Inbox: where an alert becomes visible

A check that writes rows is only useful if something reads them. Without a configured push channel the reading surface is an in-app inbox, and it needs four properties or it stops being read:

- **Idempotent write.** One `notify({dedupeKey, ...})` returns the row on first write and `null` after. An hourly producer with a per-row key fills the inbox within a day.
- **Severity separate from read state.** `level` (`info`/`warn`/`danger`) and `read_at` are independent columns, so "unread danger" is one query. Conflating them loses the only count worth badging.
- **A destination.** Store `subjectType`/`subjectId` plus an in-app link; a notification with no destination is text the user must go hunting for.
- **Pruning.** Delete read rows after a retention window, or the table grows while nothing reads the tail.

Route every producer — monitor alerts, automation actions, digests, system events — through that one write, so the inbox cannot disagree with what happened. A per-day action cap should count from this table rather than separate state: one source means the limit and the audit trail cannot diverge.

Complete when: a repeated condition adds no row, unread danger is countable in one query, and clicking a row opens its subject.

## Scope: detection is not action

Monitoring reads state and reports. Anything that moves money unattended is a different job with its own gates — read `automation.md`. Say "monitoring only" when that is what was built.

Alert delivery is the other limit worth stating: without a push channel the inbox above is the only surface, so it has to be somewhere the user actually looks — and the UI should state that no external push exists, or a user away from the page assumes silence means nothing happened.

## Symptom index

| Symptom | Cause | Fix |
|---|---|---|
| Every position reports `unknown` | bisection rejected a non-finite endpoint (normal at the edge) | solve the quadratic |
| Monitor runs clean but never alerts | relied on `positionStatus` | derive from token amounts |
| Derived price is plausible but wrong side of spot | band orientation not matched to amount order | check `range.text` units, sanity-check against a known price |
| Same warning repeats hourly | no dedupe key | key on position+state+day |
| Daily summary never appears | digest insert omitted a NOT NULL column | supply subject id, status, facts, both version fields |
| "已跌出区间（上方）" | one wording for both directions | 跌破下沿 / 涨破上沿 |
| Alert list shows a bare position id | check query skipped the join to the position row | join for pool name/token id |
| Inbox fills with the same warning every hour | producer key not scoped to condition and day | one dedupe key per condition per day |
| Band pin looks right but the number is off | a 6-decimal price rendered through a 2-decimal currency formatter | render prices with their own precision |
