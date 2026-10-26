# onchainos CLI

Read this when implementing the `defi-lp-plan` step 7 handoff. Records the verified calling conventions and the two traps that cost real debugging time.

## Install and location

`npx -y @okxweb3/onchainos-installer install` puts the binary at `~/.local/bin/onchainos` (not on `PATH` for a fresh non-login shell — resolve the absolute path or prepend the directory). Installation also drops skills into `~/.agents/skills/` (`okx-defi`, `okx-agentic-wallet`, …). Read those for parameter semantics: `--help` is terse and a wrong decimal place is expensive on a trade.

Invoke with an argument array (`execFile`), never a shell string. The CLI aborts with a core dump on SIGPIPE when its output is piped into `head -c`, which looks like a crash rather than truncation — capture to a file or read the full stream instead.

## Flag names are not consistent across subcommands

| Subcommand | Pool selector |
|---|---|
| `defi calculate-entry` | `--id` |
| `defi detail` / `prepare` / `deposit` | `--investment-id` |

Passing `--id` to `detail` fails with `error: unexpected argument '--id' found` and prints usage — it does not say "use --investment-id". Check the subcommand's own `--help` rather than assuming the sibling's spelling.

## Units differ by subcommand

- `calculate-entry --input-amount` wants **minimal units**: `5000000` for 5 USDC (6 decimals).
- `invest --amount` also wants **minimal units** (first token); a V3 entry adds `--tick-lower`/`--tick-upper` (or `--range`) or it refuses with the pool's current tick and spacing in the message — useful numbers, so read the error rather than guessing ticks.
- `deposit --user-input` wants **human units** in a JSON array: `[{"tokenAddress":"0x…","chainIndex":"8453","coinAmount":"0.05"}]`.
- `contract-call --amt` wants the step's own `valueNormalized` passed through **verbatim** — already a minimal-unit integer string. Do not recompute it from `value`, which is hex.

Mixing them silently asks for a millionth of the intended size, or a million times it.

## No sizing at all is a different verdict from zero amounts

`calculate-entry` has three outcomes, and two of them both look like "nothing":

| Response | Meaning |
|---|---|
| `{ok:true, data:{investWithTokenList:[…non-zero…]}}` | tradable; these are the legs |
| `{ok:true, data:{investWithTokenList:[{coinAmount:"0"},…]}}` | sizing computed, **wallet cannot cover it** |
| `{ok:true, data:null}` | **no executable sizing for this pool at any size** |

The third one is not a balance shortfall and raising the amount will not fix it. Verified on X Layer, same binary, same call shape, minutes apart:

```
USDG-USDT  id 2002780251  TVL $6.78M   0.01 / 0.1 / 0.5 USDT → non-zero legs
USDT-USDC  id 2329606854  TVL $1.42M   0.01 / 0.05 / 0.1 / 1 / 5 / 10 / 50 USDT → data:null
```

The wallet held 9.667 USDT and 0.40 USDC, so both legs were funded and the requested sizes were trivially affordable. `data:null` persisted across four orders of magnitude of amount. `defi invest` on the same pool fails consistently with exit 1 and `investWithTokenList not found in prepare response`.

Discriminate in two calls, not by trial and error:

1. Probe the pool at a size you can certainly afford **and** one far above it. `null` at both ends is a pool verdict; a shortfall would clear at the small size.
2. Re-run the same probe on a pool known to work on that chain. If that one sizes and this one does not, the pool is the variable — not the balance, not the tick range, not the code.

A pool can carry a valid `investmentId` in `search` results and still be unexecutable, so "it resolved to an id" is not evidence it can be entered. Decide this when the plan is built and return it on the plan; discovering it at 下单 after the user has committed is the same bad surprise as an unlisted pool.

## A zero split means unaffordable

If `calculate-entry` returns `coinAmount: "0"` for every token while answering `ok: true` **with a list present**, the sizing ran and the wallet cannot cover the pool. Do not read it as a broken integration.

A verified pair of results isolates it to balance:

```
base    (balance $0)        → 5 / 500 / 5000 USDC all return coinAmount 0
xlayer  (funded, 1 USDG)    → USDG 1000000 + USDT 1266527   (non-zero)
```

Same binary, same tick parameters, different chain funding. Amount and range width are not the variable here — both were varied on the unfunded chain and stayed zero. (Contrast the `data:null` case above, where no amount helps.)

Two ordinary causes must be ruled out first:

1. **Empty wallet on that chain.** A plan built for a chain holding nothing is not executable, however good the ticks are.
2. **A second leg you lack.** `calculate-entry` sizes against the whole wallet, so a pair whose *other* token you do not hold also returns zeros even though the token you named is funded. See the dual-leg rule under Executing.

A funding check therefore belongs in the plan response: report the balance per chain for **both** tokens of the pair, and state which chain the plan can actually execute on.

## Balances are cached; `--force` re-reads

`wallet balance` serves a cached total. Immediately after a confirmed deposit, the read still showed the pre-deposit figures ($15.30 total, unchanged token amounts); `wallet balance --all --force` returned the real post-trade numbers ($14.36).

Consequence for a funding check: a pre-trade balance read minutes after any trade can be stale in either direction. Use `--force` when the number decides whether to block an order or reports what was spent. Do not conclude a deposit failed because the balance did not move — reconcile against the position (`defi positions`) as well, which reflected the new holding on the first read.

## Resolving a pool to an investment id

`defi search --chain <c> --product-group DEX_POOL --token <symbol>` returns candidates. Never match on name alone: one pair appears at several fee tiers under the same displayed name.

Verified on Base:

```
WETH/USDC 0.3%    → 326890603   (detail: ETH-USDC, feeRate 0.003)
WETH/USDC 0.05%   → 31008       (detail: ETH-USDC, feeRate 0.0005)
cbBTC/USDC 0.05%  → 466180455   (detail: USDC-cbBTC, feeRate 0.0005)
```

The two sides do not share a naming convention, and the divergence is bigger than wrapping. Compare the same pools as each side spells them:

| Data source | CLI |
|---|---|
| `USDC / wTSLAx` | `TSLAx-USDC` |
| `USDC / USD₮0` | `USDT-USDC` |
| `WETH / USDC` | `ETH-USDC` |

A normalization that only strips a leading `W` resolves Base and fails every pair on a chain that uses tokenized-stock or tether-sign symbols — and it fails as "no pool with matching fee tier and pair", which looks like the pool is unsupported rather than the symbol unmatched. Normalize both sides with the same function:

```
uppercase → replace ₮ with T → strip spaces
→ drop a leading W before a letter        (WETH→ETH, wTSLAx→TSLAx)
```

Then treat two symbols as equal when they also match after removing a trailing `x` (`TSLAX`/`TSLA`) or a trailing `0` (`USDT0`/`USDT`). Match on three things together:

1. **Fee rate** — `search.feeRate` is a fraction (`0.003`), so divide a percent fee tier by 100 before comparing.
2. **Token pair** — apply the normalization above. Confirm against `detail.underlyingToken`, which is authoritative; treat a mismatch there as a failed resolution, not a warning.
3. **TVL closest to ours** — the same pool can appear at different snapshot values. Sorting by largest TVL picks the wrong one when two fee tiers exist; proximity to the TVL we already measured is the better disambiguator.

Verified after the fix, on a chain where the pair names share no literal with the source (4/4):

```
USDC/wTSLAx 0.05%  → 2302940237
wQQQx/USDC  0.05%  → 2302940232
USDC/USD₮0  0.01%  → 2329606854
USDC/WOKB   0.05%  → 42860
```

### The search page is capped, and a listed pool may still be absent

`defi search` returns a fixed page of 20. `--page-num` did not advance past it in testing — pages 1–3 each reported `total: 20` — so treat one keyword as ~20 candidates, not a complete listing.

- Query **both** symbols of the pair. Searching only the base can miss the pair entirely: on X Layer `--token USDC` returned 20 unrelated `*-USDC` pairs with no `USDC-USDG` among them.
- A pool that exists in the price data source may not be listed by the CLI at all. Verified: `USDC/USDG 0.01%` had ~$1.0M TVL in the pool API, and querying **both** symbols (40 candidates after dedupe, i.e. no overlap between the two result sets) still produced zero match — the pair is simply not carried.

So resolving an id has three outcomes, and the third is not a retryable error: **resolved**, **not listed**, **ambiguous**. Decide tradability when the plan is built and return it on the plan; discovering it when the user presses 下单 is a bad surprise after they have already committed to allocating.

## Chain names differ between the CLI and the data source

`--chain` takes the CLI's own spelling, which is not always the data source's. `xlayer` is valid; the data source's `x-layer` fails here with `unsupported chain`. Keep one table in the app and convert at the call site rather than passing a data-source id straight through.

## Wallet addresses: the array key varies by chain

`wallet addresses --chain <c>` does **not** always return addresses under `evm`. On X Layer the entry arrives under a `xlayer` key with an empty `evm` array:

```
--chain base    → { evm: [{address: 0x…}] }
--chain xlayer  → { evm: [], xlayer: [{address: 0x…, chainName: "okb"}] }
```

Reading only `evm` yields an empty list, and the empty string then flows into every downstream `--address` — which surfaces as a failed calculation or an empty result, not as an address error. Collect from every address array in the response (`evm`, plus the chain-named key, plus `bitcoin`/`solana`/`sui` as applicable) and dedupe.

## Wallet login

`onchainos wallet login` is a browser social login (Google / Apple / email) that the agent cannot complete. Treat logged-out as a blocking prerequisite:

1. `--phase init` mints `authSessionId` + `loginUrl`. It does not log in.
2. Hand the `loginUrl` over verbatim — the `tempPubKey` query parameter is part of the credential, so never shorten it. Say it is time-limited.
3. `--phase poll --session-id <id>` blocks until the user authorizes. Run it with a long timeout or in the background; foreground looks hung.

Completion is only `onchainos wallet status` → `loggedIn: true` with a nonzero `accountCount`. A poll process exiting is not proof.

After login the CLI returns addresses for BTC / EVM / Solana / SUI. Query balances per chain (`wallet balance --chain <c>`); the `--all` form nests results under an account id and parses differently, so code that reads one shape reads the other as empty.

Balance shapes differ within the same command family:

```
--chain <c>  → data.details[]           each with .tokenAssets[]
--all        → data.details.<accountId>.data[]  each with .tokenAssets[]
```

Write one extractor that handles both (`Array.isArray(details)` → iterate; else iterate `Object.values(details)` → `.data[]`), or the funding check silently reads $0 on whichever form it was not written for.

## Token decimals: the address field is `tokenContractAddress`

`defi detail` returns `underlyingToken[]` with `tokenAddress` but **null** `decimal`. To get precision, call `token search` — and read `tokenContractAddress`, not `tokenAddress`:

```
token search --query 0x779ded… --chains 196
→ { tokenContractAddress: "0x779ded…", decimal: "6", tokenSymbol: "USDT" }
```

Reading only `tokenAddress` yields an undefined address match, hence `decimal: null`, which blocks every execution with "cannot get token decimals" — a message that points at the token rather than at the field name you read.

## Executing: `defi invest` → `wallet contract-call`

`defi invest` returns **unsigned** calldata: `dataList[]`, each entry with `to`, `serializedData`, `value`, `valueNormalized`. The CLI never signs. Signing is `wallet contract-call`, one step at a time.

Verified shape for one V3 entry on a stable pair — three steps, and the order is the meaning:

```
0  approve  to=<tokenA>   serializedData 0x095ea7b3…
1  approve  to=<tokenB>   serializedData 0x095ea7b3…
2  deposit  to=<router>   serializedData 0xc0f41eb5…
```

- Pass `to`, `serializedData` and `valueNormalized` **verbatim**. Never re-encode, trim, pad or re-derive: the payload is opaque and a regenerated one may not be what the user approved.
- Any step carrying `valueNormalizeError` aborts the whole run — not just that step.
- The two approvals are **unlimited by default**: the CLI's own message reads `Token approved for unlimited amount`. Say so when handing over an execution, because it leaves the pool contract able to move the whole balance of both tokens, far beyond the size of the position. Offer to revoke or narrow the allowance after a test trade rather than letting it sit silently.
- Execute strictly `[0], [1], [2]…`, each confirmed before the next. A failed approve must never be followed by the deposit.
- `contract-call --chain` takes the **numeric chain index** (`196` for X Layer), not the CLI's chain name.

### A V3 entry debits both tokens, whatever you specified

Passing a single `--token` + `--amount` does **not** make the deposit single-sided. The pool needs both sides in proportion, so it pulls the other token from the wallet too.

Measured on a verified 0.5-USD₮0 entry into a stable pair:

```
requested   --token <USD₮0> --amount 500000     (0.5 USD₮0)
actually debited  USD₮0 0.499998 + USDG 0.445588  = 0.945586
deposit value     0.944982   (difference −0.0006: slippage/rounding)
```

A preview that shows only the named token understates the cost by roughly half and hides a balance requirement. Before generating calldata, call `calculate-entry` and turn `investWithTokenList` into per-token legs (`symbol`, human amount, wallet balance, `enough`); block when **any** leg is short, and render both legs.

The cost of the split is set by the pool's tick range, so it moves when the range moves — recompute per plan, never hardcode a ratio.

### `confirming` — exit code 2 is neither success nor failure

A state-changing `contract-call` does **not** broadcast on its first invocation for that step. It exits **2** with `confirming: true`, a human `message`, and `next` (usually the same args plus `--force`). Nothing is signed yet.

Observed live on a real 3-step stable-pair deposit (0.5 USD₮0 into a V3 pool), so this is behaviour, not just documentation. The full sequence, one HTTP call per line:

```
calling confirm  → confirming, stepIndex 0,   message "Token approved for unlimited amount"
calling confirm  → step 0 hash + confirming, stepIndex 1, same message
calling confirm  → steps 1 and 2 hashes, no confirming → done
```

That run raised it twice for three steps. **Do not generalize to "once per step".** A later 2-step exit on the same integration returned both hashes and `ok: true` on its **first** call, with no `confirming` at all:

```
calling confirm  → step 0 hash + step 1 hash, ok → done
```

So the count is the CLI's decision, not a function of step count. Design a bounded loop that continues until `ok` or a hard error, keyed on step index, not a single yes/no and not a fixed number of rounds. A flow expecting exactly one extra confirmation per step hangs on entries that raise fewer, and adds a useless round trip on exits that raise none.

The message can be identical across steps (both approvals said "unlimited amount"), so do not dedupe confirmations by message text — dedupe by step index.

Also confirmed: the vendor's bundled skills (`~/.agents/skills/okx-agentic-wallet/SKILL.md` § Confirmation and `~/.agents/skills/okx-agentic-wallet/references/wallet-cli-reference.md`) describe the same protocol and remain the authority if a version changes.

Both misreadings touch money:

- Reading exit 2 as failure → a deposit is reported failed that may have gone through.
- Reading `confirming` as success → a position is marked open and stamped with a tx hash that does not exist.

Wrapper consequence: **parse stdout before branching on the exit status.** A wrapper that starts with `if (err) return failure` never observes `confirming`, because the process exited non-zero by design.

Drive it as a loop, and never force automatically:

```
call step N without --force
  → confirming → surface `message` to the user, keep the token
  → user confirms → re-call step N WITH --force → tx hash → step N+1
```

`--force` is legitimate only after the unforced call returned `confirming`, its message was shown, and the user confirmed again. Forcing on the first call bypasses the CLI's own human-in-the-loop check — and a service that does that has removed the last thing standing between a bug and the money.

The position exists only when the final step returns a hash. Set the plan's state and store the tx at that moment, not before.

## Symptom index

Quick lookup for the mechanics above. Each row's fix names a rule stated in this file or in `SKILL.md` §7 — none is a new procedure.

| Symptom | Cause | Fix |
|---|---|---|
| `defi list` → "session expired" / login poll hangs | not logged in; the poll waits on the user | hand over `loginUrl`; completion is `wallet status` |
| Deposit reported done but no position | `confirming` read as success | loop to a tx hash; the position exists only then |
| Deposit reported failed but may have broadcast | exit 2 read as failure, or the wrapper returns on `err` first | parse stdout before branching |
| Multi-step deposit stops after one approval | `confirming` treated as a one-off gate | loop until ok; the count is not fixed |
| Flow hangs waiting for a per-step confirmation | assumed one `confirming` per step | a run can complete first-call with none |
| Two steps treated as one confirmation | deduped by message text | key on step index |
| Preview understates cost by ~half | V3 entry debits both tokens | legs from `calculate-entry`, show all |
| "Insufficient" though the named token is funded | the other leg is short | check both legs |
| Balance unchanged right after a trade | cached read | `--force`; reconcile with `defi positions` |
| "cannot get token decimals" | read `tokenAddress`; the field is `tokenContractAddress` | read `tokenContractAddress` first |
| Pool exists in price data but never resolves | `defi search` caps at 20 per keyword | query both symbols; "not listed" is a verdict, not a retry |
| `calculate-entry` all-zero amounts | the wallet cannot cover the pool | check both legs per chain before editing code |
| `calculate-entry` returns `data:null` at every size | the pool has no executable sizing; not a shortfall | probe small **and** large, re-probe a known-good pool, mark untradable |
| downstream `--address` empty | address arrives under a chain-named key, not `evm` | read every address array |
| investment id never resolves off Base | normalization only handled `WETH`/`WBTC` | normalize `₮`, stock `x` suffix, `USDT0` |
| `unexpected argument '--id'` | flag spelling differs per subcommand | read that subcommand's `--help` |
