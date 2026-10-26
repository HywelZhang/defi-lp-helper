# V3 Tick Math

Read this when implementing the range → tick conversion in `defi-lp-plan` step 3. These are the formulas and pure functions; the skill's step states the two rules that matter.

## Price ↔ tick

Uniswap V3 prices are expressed as token1 per token0:

```
price = 1.0001 ^ tick
tick  = ln(price) / ln(1.0001)
```

`ln(1.0001) ≈ 9.9995e-05`, so one tick is ~1 basis point.

## Orientation: address order decides

Uniswap orders the pair by **contract address**, not by symbol or by which side the UI calls "base":

- `token0` = lower address, `token1` = higher address
- `price` is always token1 per token0

Given a source that reports quote-per-base:

```
if baseAddress < quoteAddress:   # token0 = base
    price_token1_per_token0 = quote_per_base
else:                            # token0 = quote, so the ratio inverts
    price_token1_per_token0 = 1 / quote_per_base
```

Orientation is the step that fails silently. A pair ordered by symbol still produces a plausible integer tick pair — it is simply the range around `1/price` instead of `price`, so the position sits on the wrong side of spot and the usual symptom is "out of range immediately on entry" rather than an error.

Address comparison is lexicographic on the lowercased hex string; checksummed and lowercase forms must be normalized before comparing.

## Tick spacing

Both bounds must be multiples of the fee tier's spacing or the router rejects the transaction:

| Fee tier | Spacing |
|---|---|
| 0.01% | 1 |
| 0.05% | 10 |
| 0.3% | 60 |
| 1% | 200 |

Fee tiers often arrive only as a suffix in the pool name (`WETH / USDC 0.3%`). Parse it; when absent, treat APR as unknown rather than defaulting the tier to a guess.

## Align outward

```
tickLower = floor(rawLower / spacing) * spacing
tickUpper = ceil (rawUpper / spacing) * spacing
```

Rounding inward is the tempting optimization — it concentrates liquidity and raises fee share — but it systematically delivers a range narrower than the user approved, i.e. more IL risk than was agreed. Round outward and report that the realized width is slightly wider.

After aligning, clamp to the global bounds `±887272` and re-align the clamp itself, or the bound will not be a spacing multiple.

## Recommended centre

For a new position, centre on the current tick. Do not centre on a moving average unless the plan explicitly intends a directional bet: a mean-reversion centre means part of the deposit starts outside the range and earns nothing.

## Coverage probability

For a driftless lognormal price, the probability of staying within `[L, U]` over `T` years is given by the reflection-principle series:

```
σ_T = σ_annual × sqrt(T)
a = ln(L / S) / σ_T        # negative
b = ln(U / S) / σ_T        # positive
P   ≈ Σ_{k=-6..6} [ Φ(b - 2k(b-a)) - Φ(a - 2k(b-a)) ]
```

Six terms each side is ample for a UI estimate. Approximate `Φ` with Abramowitz & Stegun 7.1.26 (max error ~1.5e-7).

Choosing the half-width: widen until `P ≥ 0.70`, scanning in ~1% steps. Report `P` next to the width — it is the number that tells the user what they are accepting.

## IL reference

Constant product, given price ratio `r = P_end / P_start`:

```
IL = 2·sqrt(r)/(1+r) - 1
```

Symmetric: `r = 2` and `r = 0.5` both give ≈ −5.72%. Concentrated positions lose strictly more once the price leaves the range, so quote this as a lower bound.

## Worked check

Real pool, used to validate the implementation:

```
pool       WETH / USDC 0.3%
addresses  WETH 0x4200...0006  <  USDC 0x8335...2913   → token0 = WETH
price      2336.16 USDC per WETH
centre     77566.5  → tick 77567
spacing    60
±9%        76620 → 78480   (both divide by 60)
bounds     2125.19 → 2559.60
realized   ±9.30%  (widened by alignment, as intended)
```

Three assertions worth running on any implementation:

- `lower < price < upper` — catches inverted orientation
- `lower % spacing == 0 && upper % spacing == 0`
- realized half-width ≥ requested half-width
