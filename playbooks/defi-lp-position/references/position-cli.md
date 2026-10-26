# Position CLI Shapes

Read this when implementing `defi-lp-position`. Records the verified payload shapes, the nesting that is easy to get wrong, and the extractor skeleton.

## Overview: `defi positions`

```bash
onchainos defi positions --address <addr> --chains 196
```

`--chains` is required (comma-separated chain ids). Result:

```
data.assetStatus
data.walletIdPlatformList[]        one per account
  .accountId
  .platformList[]
     .analysisPlatformId   ← the platformId that position-detail demands
     .platformName         e.g. "Uniswap V3"
     .investmentCount      skip when 0
     .currencyAmount       protocol total
     .networkBalanceList[] .chainIndex, .network
```

No `tokenId` anywhere at this level. That is the reason the detail call is mandatory.

A wallet holding nothing returns `{assetStatus: 1}` with no `walletIdPlatformList` key at all — treat a missing list as empty, not as an error.

## Detail: `defi position-detail`

```bash
onchainos defi position-detail --address <addr> --chain xlayer --platform-id 68
```

`--chain` here takes the **CLI** chain name (`xlayer`), not the data-source spelling. See the chain table in `defi-fact-pipeline`.

`data` is a **list**, not an object. Indexing it as an object yields `undefined` and a confusing "no positions" result.

```
data[]                              ← list
  .analysisPlatformId
  .platformName
  .walletIdPlatformDetailList[]
    .networkHoldVoList[]
       .chainIndex
       .investTokenBalanceVoList[]
          .investmentId            ← the id withdraw wants
          .investmentName          e.g. "USDG-USDT"
          .totalValue              USD
          .feeRate                 fraction, "0.00010"
          .detailPath
          .assetsTokenList         ← EMPTY for V3 pools
          .positionList[]          ← the real data is here
```

For each `positionList[i]`:

```
.tokenId                 "63893"   ← required by withdraw
.positionStatus          "ACTIVE"  ← always ACTIVE while the position exists; it does NOT distinguish in-range from out-of-range (see monitoring.md)
.totalValue
.range                   "0.97093 - 1.03107 USDG per USDT"
.rangeInfo { lowerPrice, upperPrice, tickLower, tickUpper, token0Symbol, token1Symbol }
.assetsTokenList[]       ← the actual split
    .tokenSymbol .tokenAddress .coinAmount .currencyAmount .tokenPrecision
.unclaimFeesDefiTokenInfo[]
    .baseDefiTokenInfos[]  .tokenSymbol .tokenAddress .coinAmount .currencyAmount
```

Non-V3 products (lending, single-earn) have no `positionList`; their amounts do sit on `investTokenBalanceVoList[].assetsTokenList`. So read the position-level list first and fall back to the wrapper.

## Extractor skeleton

```ts
function flatten(raw: any, chain: string) {
  const out = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    const platformId = Number(g?.analysisPlatformId ?? 0);
    for (const w of g?.walletIdPlatformDetailList ?? [])
      for (const h of w?.networkHoldVoList ?? [])
        for (const it of h?.investTokenBalanceVoList ?? []) {
          const positions = it?.positionList ?? [];
          const mapTokens = (l: any[]) => (l ?? []).map((t) => ({
            symbol: String(t?.tokenSymbol ?? ""),
            address: String(t?.tokenAddress ?? ""),
            amount: Number(t?.coinAmount ?? 0),
            decimals: Number(t?.tokenPrecision ?? 18),
            valueUsd: Number(t?.currencyAmount ?? 0),
          }));
          const push = (pl: any, tokenId: string | null) => {
            const fees = [];
            for (const f of pl?.unclaimFeesDefiTokenInfo ?? [])
              for (const t of f?.baseDefiTokenInfos ?? []) {
                const amt = Number(t?.coinAmount ?? 0);
                if (amt > 0) fees.push({ symbol: t?.tokenSymbol, amount: amt });
              }
            out.push({
              investmentId: Number(it?.investmentId ?? 0),
              tokenId,
              platformId,
              name: it?.investmentName,
              valueUsd: Number(pl?.totalValue ?? it?.totalValue ?? 0),
              // position level first: the wrapper's list is empty for V3
              tokens: mapTokens(pl?.assetsTokenList ?? it?.assetsTokenList ?? []),
              fees,
              status: String(pl?.positionStatus ?? "UNKNOWN"),
              range: pl?.rangeInfo ?? null,
            });
          };
          if (positions.length) for (const pl of positions) push(pl, pl?.tokenId != null ? String(pl.tokenId) : null);
          else push(null, null);
        }
  }
  return out;
}
```

## Exit calldata

```bash
onchainos defi withdraw \
  --investment-id <id> --address <addr> --chain xlayer \
  --ratio 1 --slippage 0.01 \
  --token-id <nftId> --platform-id <pid>
```

Verified 2-step result for a full V3 exit on a stable pair:

```
0  to=0x315e413a…  sel=0xa22cb465  len=138    setApprovalForAll (NFT)
1  to=0x90250606…  sel=0xc0f41eb5  len=2058   reduce liquidity
```

- `0xa22cb465` = ERC721 approve, `0x095ea7b3` = ERC20 approve. Label them differently: an exit delegating the NFT is not the same consent as approving a token amount.
- `--ratio 1` full, `0.5` half. `--amount` exists for human-readable partial amounts.
- Both calls return `dataList[]` with `to` / `serializedData` / `valueNormalized` — pass verbatim, same as entry.

Fees:

```bash
onchainos defi collect --address <addr> --chain xlayer \
  --reward-type REWARD_INVESTMENT --investment-id <id> --platform-id <pid> --token-id <nftId>
```

An empty `dataList` here is a legitimate outcome: nothing accrued to claim. Report that, not a failure.

## Two-phase confirmation is not per-step

The same wrapper that drives entry drives exit. Verified on this integration:

```
3-step entry:  call → confirming(step 0) → call → step0 hash + confirming(step 1) → call → steps 1,2 hashes
2-step exit:   call → both hashes, ok, no confirming at all
```

So a fixed number of extra confirmations is wrong in both directions. Loop until `ok` or a hard error; keep the token alive across iterations; mark the position closed only when the final step returns a hash.

## Balance lag

`wallet balance --all` served the pre-trade figures immediately after a confirmed withdraw, and the corrected total appeared ~20 s later. `--force` re-reads. `defi positions` updated immediately.

Consequence: after a close, wait and re-read before reporting either success or failure, and prefer the position list (authoritative, fresh) over the cached total when they disagree.

## Rebalance: withdraw, then re-enter

There is no `increase`/`decrease` subcommand, and a V3 range is fixed at mint. Moving a range is therefore:

1. `defi withdraw --ratio 1` (full exit) on the old NFT — the same call as a close.
2. `defi invest --tick-lower <n> --tick-upper <n>` on the pool, passing **both** legs via `--token/--amount` and `--token2/--amount2`.

Two separately confirmed batches, not one. Persist the target ticks and the released legs before generating step 1: if step 2 fails, the capital is loose in the wallet and the stored intent is the only record that it is waiting to be redeployed.

Recompute the target ticks from the pool's **current** price. Reusing the old plan's ticks puts the position straight back where it was.

Measured cost, stable pair, ~$0.94 position: **0.5–0.9% per round** (ratio slippage on exit plus 0.1% haircut and rounding on re-entry). Three rounds compounded to −1.80%. Say this before recommending a rebalance on a small position.

### The rebuild mints a new NFT — merge it back

Withdrawing burns the old NFT; re-entering mints a new `tokenId`. Sync therefore sees an unknown NFT and inserts a second row, while the origin row's NFT vanishes from the chain and gets marked closed. One user action becomes "closed" + "opened", cost is counted twice, and the page shows roughly −50%.

Indexing lags, so this cannot be handled once at the end of the rebuild. Merging has to run on **every** sync:

```ts
// origin rows still mid-rebalance
SELECT * FROM positions
 WHERE chain=? AND address=?
   AND rebalance_json IS NOT NULL
```

For each origin whose intent phase is not `done`, find the row this rebuild minted and fold it in.

**`investment_id` is not unique — one pool can hold several positions at once, and they all share it.** Selecting "the newest other open row in the same pool" therefore picks an unrelated position as often as the rebuild, and this step deletes what it picks. Bound the match on two things:

```sql
SELECT * FROM positions
 WHERE chain=? AND address=? AND investment_id=? AND status='open' AND id<>
   AND COALESCE(value_usd,0) > 0
   AND opened_at >= ?            -- intent.startedAt: the rebuild cannot predate it
 ORDER BY opened_at DESC LIMIT 1
```

- **Time bound.** The rebuild row is inserted after the rebalance began, so `opened_at >= intent.startedAt` separates "the NFT we just minted" from "a position that was already sitting in the pool". Without it a legitimate sibling position is matched and destroyed.
- **Plan bound.** Skip the candidate when it already carries a *different* plan id. The rebuild row is always inserted unplanned; a row bound to another plan belongs to another trade.

Delete the duplicate **first**: `UNIQUE(chain,address,investment_id,token_id)` rejects pointing the origin at an NFT the duplicate still holds.

```sql
DELETE FROM position_events WHERE position_id = :dup;
DELETE FROM positions       WHERE id = :dup;
UPDATE positions
   SET token_id=:nft, value_usd=:v, last_value_usd=:v, tokens_json=:json,
       tick_lower=:lo, tick_upper=:hi, status='open', closed_at=NULL
 WHERE id = :origin;
```

Set the intent phase to `done` only when the merge actually found something. Marking it done unconditionally (as a naive post-rebuild step does) closes the window while the chain has not yet indexed the new NFT, so the later, correct merge never happens.

Keep the origin row's `id`: it carries the plan link, cost basis and event timeline. The NFT id changes; the position does not.

### Cash left in the wallet is capital, not loss

The pool consumes both legs in its own ratio, so some of what was offered stays in the wallet. Counting only the position's value reports that leftover as a loss.

Derive it from the **chain**, not from our own row: right after a rebuild the row may still hold the pre-withdraw token snapshot, which makes the leftover come out as zero or as the entire offered amount.

```
leftover = Σ over offered legs of (offered_human − chain_held_human) × unit_value
```

Store it **additively** — `cash_back_usd = COALESCE(cash_back_usd,0) + ?`. Overwriting drops the previous round's leftover, which is still the user's money. Then:

```
open:   value_usd + cash_back_usd − cost_usd
closed: proceeds_usd − cost_usd
```

The portfolio summary must sum the same basis as the rows. A summary using `value_usd` alone while rows also add cash-back showed −0.91% beside a row reading −0.16% — the same number disagreeing with itself on one screen.

Cross-check the result against the wallet: `cash_now + position_value − baseline` should equal the reported PnL. If it does not, the accounting is wrong, not the market.

## Symptom index

Each row is a quick lookup for a rule stated in `SKILL.md` or above. Left column is what you see; the fix names the rule, not a new procedure.

| Symptom | Cause | Fix |
|---|---|---|
| Position has a value but zero tokens | read `assetsTokenList` on the wrapper | read it on `positionList[i]` |
| PnL near −98% on a flat position | cost from requested capital | store the debited amount |
| Every position reads slightly worse than reality | entry legs summed as raw token amounts | convert each leg by its unit price before summing |
| Every closed position shows −100% | value reset to 0, no proceeds | store proceeds, use realized formula |
| Withdraw fails or hits the wrong range | no `--token-id` | pass the NFT id plus `--platform-id` |
| Our own trade labeled "discovered on-chain" | linked by recency before the id was stored | store investment id on the plan; match it |
| Portfolio reads empty after a partial failure | platform error swallowed | report per-platform errors |
| Exit hangs waiting for a confirmation | expected one `confirming` per step | loop until ok; count is not fixed |
| "Trade failed" though funds returned | checked balance immediately after the tx | re-read after a delay; check positions too |
| Duplicate position rows | keyed on investment id alone | key on chain+address+investment+tokenId |
| Rebalance shows as closed + new position | rebuild mints a new NFT, inserted as its own row | merge into the origin row on every sync, not once |
| A sibling position vanished from the portfolio | merge matched on `investment_id` alone; one pool shares it across positions | bound by `opened_at >= intent.startedAt` and reject a different plan id |
| PnL wrong after a rebalance | capital left uninvested in the wallet ignored | store cash-back, accumulate it, read from chain |
