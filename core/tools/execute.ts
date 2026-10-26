/**
 * Real execution of a saved plan through onchainos.
 *
 * This spends real money, so it is deliberately two-phase:
 *
 *   prepare()  — balance check, generate calldata, return a preview + token
 *   confirm()  — consume the token, sign & broadcast each step in order
 *
 * Why two phases instead of one call:
 *   - the user must see the actual token amounts and contract addresses before
 *     anything is signed
 *   - a double-click must not submit twice (the token is single-use)
 *   - the confirmed calldata must be the exact bytes previewed, never regenerated
 *
 * onchainos never holds the plan's numbers: `defi invest` returns UNSIGNED
 * calldata, and `wallet contract-call` does the TEE signing. We pass through
 * `to` / `serializedData` / `valueNormalized` verbatim — the docs are explicit
 * that prepared tx data must never be re-encoded or edited.
 */

import { randomBytes } from "node:crypto";
import {
  runOnchainos, walletAddresses, chainBalance, calculateEntry,
  withdrawCalldata, collectCalldata,
} from "./onchainos.ts";
import { onchainosChain, chainConfig } from "../config.ts";
import { planGet, planSetStatus, executionBlockers } from "./plan.ts";
import { run, one } from "../db.ts";

const TOKEN_TTL_MS = 5 * 60_000;

interface PendingExec {
  /** what this batch of calldata does */
  kind: "open" | "withdraw" | "collect" | "rebalance_withdraw" | "rebalance_rebuild";
  planId: string;
  /** position row this action belongs to (withdraw/collect) */
  positionId?: string;
  steps: { to: string; data: string; value: string }[];
  inputAmount: string;
  inputToken: string;
  investmentId: string;
  chain: string;
  address: string;
  createdAt: number;
  /** guards against the same token being confirmed twice */
  used: boolean;
  /** steps already broadcast successfully */
  completed: { step: number; txHash?: string }[];
  /** step index whose CLI `confirming` message the user has been shown */
  awaiting?: number;
  /** one in-flight broadcast at a time */
  broadcasting?: boolean;
  /** real cost of an open, in USD — taken from the preview legs, not the plan */
  costUsd?: number;
  /** token legs, snapshotted at prepare time */
  legs?: { symbol: string; address: string; amountHuman: string; decimals: number }[];
  /** total position value at prepare time (withdraw) */
  valueUsd?: number;
}

const pending = new Map<string, PendingExec>();

/** Drop expired tokens so the map cannot grow without bound. */
function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > TOKEN_TTL_MS) pending.delete(k);
  }
}

export interface TokenLeg {
  symbol: string;
  address: string;
  /** minimal units */
  amount: string;
  /** human units */
  amountHuman: string;
  decimals: number;
  /** wallet balance of this token on the target chain */
  balance: number;
  enough: boolean;
}

export interface PrepareResult {
  ok: boolean;
  error?: string;
  /** reasons this plan was refused; empty on success */
  blockers?: string[];
  /** true when the refusal can be overridden with an explicit, recorded reason */
  canForce?: boolean;
  confirmToken?: string;
  expiresInSec?: number;
  preview?: {
    planId: string;
    pool: string;
    chain: string;
    address: string;
    inputToken: string;
    inputAmount: string;
    inputAmountHuman: string;
    balanceBefore: number;
    /**
     * A V3 deposit is NOT single-sided. Supplying only the quote token still
     * debits the base token, because the pool needs both sides in proportion.
     * The real run for 0.5 USDT debited 0.499998 USDT *and* 0.445588 USDG.
     * Both legs must be shown and both balances checked.
     */
    legs: TokenLeg[];
    totalValueUsd: number;
    steps: { index: number; to: string; kind: "approve" | "deposit"; dataLength: number }[];
    estimatedGasNote: string;
  };
}

/** Resolve a token's decimals via onchainos token search. */
export async function tokenDecimals(chain: string, tokenAddress: string): Promise<number | null> {
  const r = await runOnchainos<any>(
    ["token", "search", "--query", tokenAddress, "--chains", String(chainConfig(chain).chainId)],
    40_000,
  );
  const list = Array.isArray(r.data) ? r.data : [];
  const want = tokenAddress.toLowerCase();
  // token search returns the address under `tokenContractAddress`; some
  // endpoints use `tokenAddress`. Reading only one silently yields null and
  // blocks every execution with "无法获取精度".
  const hit = list.find((t: any) => {
    const a = String(t?.tokenContractAddress ?? t?.tokenAddress ?? "").toLowerCase();
    return a === want;
  });
  const dec = Number(hit?.decimal);
  return Number.isFinite(dec) ? dec : null;
}

/**
 * Phase 1: build the exact calldata and show it.
 * Balance is checked BEFORE generating anything, per the CLI docs — generating
 * calldata for an unfunded wallet just wastes a round trip and produces a
 * transaction that reverts.
 */
export async function prepareExecution(
  planId: string,
  inputAmountHuman: number,
  opts: { force?: boolean; forceReason?: string } = {},
): Promise<PrepareResult> {
  sweep();

  const plan = planGet(planId);
  if (!plan) return { ok: false, error: "计划不存在" };
  if (plan.status === "active") return { ok: false, error: "该计划已执行过，请重新生成计划" };

  const payload: any = plan.payload;
  const chain: string = plan.chain;
  const ticks = payload.ticks;
  if (!ticks) return { ok: false, error: "计划缺少 tick 坐标，无法执行" };

  // Hard gate. Checked here rather than only at plan time so plans saved earlier
  // — including ones built before these rules existed — cannot be executed now.
  //
  // An override is allowed, but it must be explicit and it must be recorded.
  // The point is not to make trading impossible; it is to make trading blind
  // impossible, and to leave a trail when the warning was knowingly ignored.
  const blockers = executionBlockers(payload);
  if (blockers.length) {
    if (!opts.force) {
      return {
        ok: false,
        error: `已拦截：${blockers.join("；")}`,
        blockers,
        canForce: true,
      } as PrepareResult;
    }
    const reason = String(opts.forceReason ?? "").trim();
    if (reason.length < 4) {
      return {
        ok: false,
        error: "强制下单必须写明理由（至少 4 个字），否则无法记录",
        blockers,
        canForce: true,
      } as PrepareResult;
    }
    console.warn(`[force-execute] plan=${planId} blocked=${blockers.join("|")} reason=${reason}`);
  }

  const address = (await walletAddresses(chain))[0];
  if (!address) return { ok: false, error: "钱包未登录或该链无地址" };

  // the investmentId must be resolved fresh; it is not part of the frozen plan
  const { resolveInvestmentId } = await import("./onchainos.ts");
  const res = await resolveInvestmentId({
    chain,
    baseSymbol: payload.pool.baseSymbol,
    quoteSymbol: payload.pool.quoteSymbol,
    feeTierPct: payload.pool.feeTierPct,
    tvlUsd: payload.pool.tvlUsd,
  });
  if (!res.ok || !res.investmentId) {
    return { ok: false, error: `无法匹配 onchainos 投资 ID：${res.error ?? "unknown"}` };
  }

  // which token do we pay with? the quote side (usually the stablecoin)
  const quoteAddr: string = payload.pool.quoteAddress ?? ticks.token1;
  const dec = await tokenDecimals(chain, quoteAddr);
  if (dec === null) return { ok: false, error: "无法获取支付代币精度" };

  const inputAmount = String(Math.floor(inputAmountHuman * 10 ** dec));

  // --- work out BOTH legs before anything is generated ---
  // A V3 pool needs both tokens in proportion. Passing one token still debits
  // the other: the real 0.5-USDT run took 0.499998 USDT AND 0.445588 USDG.
  // Asking calculate-entry first gives the expected split, so the user sees
  // the true cost and we can check both balances up front.
  const bal = await chainBalance(chain);
  const balOf = (addr: string) => {
    const t = bal.tokens.find((x: any) => String(x.address).toLowerCase() === addr.toLowerCase());
    return t ? Number(t.balance) : 0;
  };

  const legs: TokenLeg[] = [];
  const ce = await calculateEntry({
    chain,
    investmentId: res.investmentId,
    address,
    inputToken: quoteAddr,
    inputAmount,
    tokenDecimals: dec,
    tickLower: ticks.tickLower,
    tickUpper: ticks.tickUpper,
  });

  const entryList: any[] = ce.ok ? (ce.data?.investWithTokenList ?? []) : [];
  const baseAddr: string = payload.pool.baseAddress ?? ticks.token0;
  const baseDec = await tokenDecimals(chain, baseAddr);

  if (entryList.length) {
    for (const e of entryList) {
      const addr = String(e.tokenAddress);
      const raw = String(e.coinAmount ?? "0");
      if (Number(raw) === 0) continue; // pool does not want this side
      const d = Number(e.tokenPrecision ?? (addr.toLowerCase() === quoteAddr.toLowerCase() ? dec : baseDec ?? 18));
      const isQuote = addr.toLowerCase() === quoteAddr.toLowerCase();
      const symbol = isQuote ? payload.pool.quoteSymbol : (addr.toLowerCase() === baseAddr.toLowerCase() ? payload.pool.baseSymbol : addr.slice(0, 8));
      const human = Number(raw) / 10 ** d;
      const have = balOf(addr);
      legs.push({
        symbol, address: addr, amount: raw, amountHuman: String(human),
        decimals: d, balance: have, enough: have >= human,
      });
    }
  }

  // calculate-entry can fail (rate limits, unsupported pool); fall back to the
  // single requested leg rather than blocking, but flag nothing we cannot prove.
  if (!legs.length) {
    const have = balOf(quoteAddr);
    legs.push({
      symbol: payload.pool.quoteSymbol, address: quoteAddr, amount: inputAmount,
      amountHuman: String(inputAmountHuman), decimals: dec, balance: have,
      enough: have >= inputAmountHuman,
    });
  }

  const short = legs.filter((l) => !l.enough);
  if (short.length) {
    const detail = short.map((l) => `${l.symbol} 需 ${l.amountHuman}、可用 ${l.balance}`).join("；");
    return { ok: false, error: `余额不足：${detail}` };
  }

  const availableHuman = legs.find((l) => l.address.toLowerCase() === quoteAddr.toLowerCase())?.balance ?? 0;

  const r = await runOnchainos<any>(
    [
      "defi", "invest",
      "--investment-id", String(res.investmentId),
      "--address", address,
      "--chain", onchainosChain(chain),
      "--token", quoteAddr,
      "--amount", inputAmount,
      "--slippage", "0.01",
      "--tick-lower", String(ticks.tickLower),
      "--tick-upper", String(ticks.tickUpper),
    ],
    90_000,
  );

  if (!r.ok) return { ok: false, error: `生成 calldata 失败：${r.error ?? "unknown"}` };

  const dataList = r.data?.dataList ?? [];
  if (!dataList.length) return { ok: false, error: "onchainos 未返回任何交易步骤" };

  // Any step carrying valueNormalizeError must not be executed at all.
  for (const s of dataList) {
    if (s.valueNormalizeError) {
      return { ok: false, error: `交易数据异常（${s.valueNormalizeError}），已中止` };
    }
  }

  const steps = dataList.map((s: any) => ({
    to: String(s.to),
    data: String(s.serializedData),
    value: String(s.valueNormalized ?? "0"),
  }));

  const token = randomBytes(18).toString("base64url");
  // Cost must be summed in USD, not in token units. USDT here is worth ~0.9989
  // USD, so adding raw token amounts overstated the cost basis and made every
  // position look slightly worse than it was. Use each token's own USD price.
  const usdPerUnit = (addr: string): number => {
    const t = bal.tokens.find((x: any) => String(x.address).toLowerCase() === addr.toLowerCase());
    const amount = Number(t?.balance ?? 0);
    const usd = Number(t?.usd ?? 0);
    if (amount > 0 && usd > 0) return usd / amount;
    return 1; // stablecoin fallback: 1:1 is close enough
  };
  const totalCostUsd = legs.reduce(
    (s, l) => s + Number(l.amountHuman) * usdPerUnit(l.address), 0,
  );
  pending.set(token, {
    kind: "open",
    planId,
    steps,
    inputAmount,
    inputToken: quoteAddr,
    investmentId: String(res.investmentId),
    chain,
    address,
    createdAt: Date.now(),
    used: false,
    completed: [],
    // real spend, not the plan's requested capital: those differ wildly
    // (plan said $50, the actual run cost $0.945)
    costUsd: totalCostUsd,
    legs: legs.map((l) => ({ symbol: l.symbol, address: l.address, amountHuman: l.amountHuman, decimals: l.decimals })),
  });

  const preview = steps.map((s, i) => ({
    index: i,
    to: s.to,
    // approve selectors are 0x095ea7b3; the last step is the actual deposit
    kind: (s.data.startsWith("0x095ea7b3") ? "approve" : "deposit") as "approve" | "deposit",
    dataLength: s.data.length,
  }));

  return {
    ok: true,
    confirmToken: token,
    expiresInSec: TOKEN_TTL_MS / 1000,
    preview: {
      planId,
      pool: payload.pool.name,
      chain,
      address,
      inputToken: quoteAddr,
      inputAmount,
      inputAmountHuman: String(inputAmountHuman),
      balanceBefore: availableHuman,
      legs,
      totalValueUsd: legs.reduce((s, l) => s + Number(l.amountHuman), 0),
      steps: preview,
      estimatedGasNote: "每步依次签名广播，前一步确认后才执行下一步",
    },
  };
}

/**
 * Phase 2: sign & broadcast.
 *
 * Steps run strictly in order and stop at the first failure — a partial
 * approve without the deposit is harmless, but a deposit without approve
 * reverts and wastes gas.
 */
export interface StepResult {
  step: number;
  ok: boolean;
  txHash?: string;
  error?: string;
}

export interface ConfirmResult {
  ok: boolean;
  error?: string;
  results?: StepResult[];
  /** onchainos wants another explicit confirmation before this step is signed */
  needsCliConfirm?: boolean;
  cliMessage?: string;
  stepIndex?: number;
  totalSteps?: number;
}

/**
 * Sign & broadcast, honouring onchainos' own two-phase confirmation.
 *
 * `wallet contract-call` returns `confirming` (exit code 2) on the first
 * invocation of a state-changing call. That response means NOTHING was signed
 * or sent. The transaction only goes out when the same command is re-run with
 * `--force`. So this function drives the loop:
 *
 *   1st call for step N  → no --force → confirming → return to the UI
 *   user sees the CLI message and confirms again
 *   2nd call for step N  → --force    → txHash     → move to step N+1
 *
 * Never auto-forces: the CLI raises `confirming` precisely to put a human in
 * the loop, and silently satisfying it would defeat that check.
 */
export async function confirmExecution(token: string): Promise<ConfirmResult> {
  sweep();

  const p = pending.get(token);
  if (!p) return { ok: false, error: "确认令牌无效或已过期，请重新生成预览" };
  if (p.used) return { ok: false, error: "该计划已执行完成，请重新生成计划" };
  if (p.broadcasting) return { ok: false, error: "正在执行中，请勿重复提交" };

  p.broadcasting = true;

  const results: StepResult[] = p.completed.map((c) => ({ step: c.step, ok: true, txHash: c.txHash }));

  try {
    while (results.length < p.steps.length) {
      const i = results.length;
      const s = p.steps[i];
      // --force only on the step whose `confirming` the user has already seen
      const force = p.awaiting === i;

      const args = [
        "wallet", "contract-call",
        "--to", s.to,
        "--chain", String(chainConfig(p.chain).chainId),
        "--input-data", s.data,
        "--amt", s.value,
        "--biz-type", "defi",
      ];
      if (force) args.push("--force");

      const r = await runOnchainos<any>(args, 180_000);

      if (r.confirming) {
        // Nothing signed yet. Hold the token and hand the prompt to the UI.
        p.awaiting = i;
        return {
          ok: false,
          needsCliConfirm: true,
          cliMessage: r.message ?? "onchainos 要求再次确认",
          stepIndex: i,
          totalSteps: p.steps.length,
          results,
        };
      }

      if (!r.ok) {
        results.push({ step: i, ok: false, error: r.error ?? "unknown" });
        // stop: an approve failure must never be followed by the deposit
        return {
          ok: false,
          error: `第 ${i + 1} 步失败：${r.error ?? "unknown"}`,
          results,
        };
      }

      const txHash = r.data?.txHash ?? r.data?.txHashList?.[0] ?? r.data?.orderId ?? null;
      results.push({ step: i, ok: true, txHash: txHash ?? undefined });
      p.completed.push({ step: i, txHash: txHash ?? undefined });
      p.awaiting = undefined;

      // brief pause: RPC nodes and the backend need a moment between txs
      if (i < p.steps.length - 1) await new Promise((r2) => setTimeout(r2, 1500));
    }

    // every step broadcast. What happens next depends on the action: an open
    // creates a position, a withdraw closes one, a collect just banks fees.
    // Treating all three as "open" would log a withdrawal as a new deposit.
    p.used = true;
    const lastTx = results[results.length - 1]?.txHash ?? null;
    const allTxs = results.map((r) => r.txHash).filter(Boolean) as string[];

    if (p.kind === "open") {
      planSetStatus(p.planId, "active");
      run(
        `UPDATE plans SET onchain_tx = ?, activated_at = ?, investment_id = ?, real_cost_usd = ? WHERE id = ?`,
        lastTx, Date.now(), Number(p.investmentId), p.costUsd ?? null, p.planId,
      );
      // Pull the new position from the chain so it exists locally with the
      // real tokenId, then attach the plan and the true cost.
      try {
        const { syncPositions, linkLatestOpenPosition } = await import("./portfolio.ts");
        await syncPositions(p.chain, p.address);
        const posId = linkLatestOpenPosition(
          p.planId, p.chain, Number(p.investmentId), p.costUsd ?? null,
          (p.legs ?? []).map((l) => ({ symbol: l.symbol, amount: Number(l.amountHuman) })),
        );
        if (posId) {
          run(
            `UPDATE positions SET cost_usd=?, last_value_usd=value_usd WHERE id=?`,
            p.costUsd ?? null, posId,
          );
        }
      } catch (e) {
        // the deposit succeeded; failing to mirror it locally must not turn a
        // successful on-chain action into an error
        console.error("post-open sync failed:", e);
      }
    } else if (p.kind === "withdraw") {
      if (p.positionId) {
        // Keep value_usd=0 (nothing is held any more) but record what came
        // back. Without proceeds a closed row reads as a 100% loss even though
        // the cash returned to the wallet.
        run(
          `UPDATE positions SET status='closed', closed_at=?, value_usd=0, proceeds_usd=?, last_value_usd=? WHERE id=?`,
          Date.now(), p.valueUsd ?? null, p.valueUsd ?? null, p.positionId,
        );
        run(`UPDATE plans SET status='closed', closed_at=? WHERE id=?`, Date.now(), p.planId);
        const { recordEvent } = await import("./portfolio.ts");
        recordEvent({
          positionId: p.positionId,
          kind: "withdraw",
          amountUsd: p.valueUsd ?? null,
          txHashes: allTxs,
          note: "平仓完成",
        });
      }
    } else if (p.kind === "collect") {
      if (p.positionId) {
        const { recordEvent } = await import("./portfolio.ts");
        recordEvent({
          positionId: p.positionId,
          kind: "collect",
          amountUsd: p.valueUsd ?? null,
          txHashes: allTxs,
          note: "领取手续费",
        });
      }
    } else if (p.kind === "rebalance_withdraw") {
      if (p.positionId) {
        const { recordEvent } = await import("./portfolio.ts");
        const { markWithdrawn } = await import("./rebalance.ts");
        // The position row itself stays OPEN: the capital is mid-flight, not
        // exited. Marking it closed here would let the rebuild create a second,
        // unrelated position and the original would look like a loss.
        run(
          `UPDATE positions SET value_usd=0, last_value_usd=? WHERE id=?`,
          p.valueUsd ?? null, p.positionId,
        );
        markWithdrawn(p.positionId, allTxs);
        recordEvent({
          positionId: p.positionId,
          kind: "withdraw",
          amountUsd: p.valueUsd ?? null,
          txHashes: allTxs,
          note: `调仓第 1 步：撤出旧区间（待重建）`,
        });
      }
    } else if (p.kind === "rebalance_rebuild") {
      if (p.positionId) {
        const { recordEvent } = await import("./portfolio.ts");
        const { markRebuilt, readIntent } = await import("./rebalance.ts");
        const intent = readIntent(p.positionId);

        // Refresh from chain so the freshly minted NFT is picked up. The sync
        // will almost certainly insert the rebuilt NFT as its OWN row (the new
        // tokenId does not match), which is exactly what we then fold back into
        // this row — one user action must read as one position.
        let newPosId: string | null = null;
        try {
          const { syncPositions, mergeRebuiltPosition, linkLatestOpenPosition } = await import("./portfolio.ts");
          await syncPositions(p.chain, p.address);
          newPosId = mergeRebuiltPosition(p.positionId, p.chain, Number(p.investmentId));
          if (!newPosId) {
            // nothing to merge: the chain still had the old NFT when we synced
            linkLatestOpenPosition(
              p.planId, p.chain, Number(p.investmentId), p.costUsd ?? null,
              (p.legs ?? []).map((l) => ({ symbol: l.symbol, amount: Number(l.amountHuman) })),
            );
          }
        } catch (e) {
          console.error("rebalance post-rebuild merge failed:", e);
        }

        // The pool never consumes both legs in the exact ratio we offered, so
        // part of the withdrawn capital stays in the wallet. Counting only the
        // position's value would report that leftover as a loss.
        //
        // Read the position's ACTUAL tokens from the chain rather than from our
        // row: right after a rebuild the row may still hold the pre-withdraw
        // snapshot (merge lags behind the chain), which made the leftover come
        // out as zero or as the entire offered amount.
        let cashBackUsd = 0;
        try {
          const { listPositions } = await import("./onchainos.ts");
          const chainPos = await listPositions(p.chain, p.address);
          const live = chainPos.positions.find(
            (x) => Number(x.investmentId) === Number(p.investmentId) && x.valueUsd > 0,
          );
          const held = live?.tokens ?? [];

          for (const o of p.legs ?? []) {
            const h = held.find(
              (x: any) => String(x.address).toLowerCase() === String(o.address).toLowerCase(),
            );
            const unused = Number(o.amountHuman) - Number(h?.amount ?? 0);
            if (unused <= 0) continue;
            const perUnit =
              Number(h?.amount ?? 0) > 0 ? Number(h?.valueUsd ?? 0) / Number(h.amount) : 1;
            cashBackUsd += unused * perUnit;
          }
        } catch (e) {
          console.error("leftover cash calc failed:", e);
        }

        // Accumulate, never overwrite: each rebalance can strand a different
        // amount in the wallet, and the previous leftover is still the user's
        // capital. Overwriting dropped it from PnL entirely.
        run(
          `UPDATE positions SET cash_back_usd = COALESCE(cash_back_usd, 0) + ? WHERE id=?`,
          cashBackUsd, p.positionId,
        );

        markRebuilt(p.positionId, newPosId, Boolean(newPosId));
        recordEvent({
          positionId: p.positionId,
          kind: "range_adjust",
          amountUsd: p.costUsd ?? null,
          txHashes: allTxs,
          note: intent
            ? `调仓第 2 步：新区间 ±${intent.halfWidthPct}%（${intent.ticks.tickLower}..${intent.ticks.tickUpper}）`
              + (cashBackUsd > 0 ? `，未投入 ${cashBackUsd.toFixed(4)} 留在钱包` : "")
            : "调仓第 2 步：已完成",
        });
      }
    }

    pending.delete(token);

    return { ok: true, results };
  } finally {
    p.broadcasting = false;
  }
}

/** Forget a prepared execution without spending anything. */
export function cancelExecution(token: string): boolean {
  return pending.delete(token);
}

/* ── withdraw / collect ───────────────────── */

export interface ClosePreview {
  kind: "withdraw" | "collect";
  positionId: string;
  pool: string;
  chain: string;
  address: string;
  tokenId: string | null;
  ratio: number;
  /** position value we expect to receive, and the fees if collecting */
  valueUsd: number;
  feesUsd: number;
  steps: { index: number; to: string; kind: string; dataLength: number }[];
  estimatedGasNote: string;
}

export interface ClosePrepareResult {
  ok: boolean;
  error?: string;
  confirmToken?: string;
  expiresInSec?: number;
  preview?: ClosePreview;
}

/**
 * Prepare an exit (or a fee claim) for a tracked position.
 *
 * Position data is re-fetched here rather than trusted from our table: the
 * docs make position-detail a mandatory pre-step for withdraw, because the
 * amounts change with every trade that hits the pool. Stale numbers produce
 * calldata that reverts.
 */
export async function prepareClose(
  positionId: string,
  action: "withdraw" | "collect",
  ratio = 1,
): Promise<ClosePrepareResult> {
  sweep();

  const { syncPositions } = await import("./portfolio.ts");
  const pos = one<any>(`SELECT * FROM positions WHERE id=?`, positionId);
  if (!pos) return { ok: false, error: "仓位不存在" };
  if (pos.status !== "open") return { ok: false, error: "该仓位已平仓" };

  // refresh from chain first: tokenId/amounts may have changed
  await syncPositions(pos.chain, pos.address);
  const fresh = one<any>(`SELECT * FROM positions WHERE id=?`, positionId);
  if (!fresh) return { ok: false, error: "仓位同步失败" };

  if (action === "withdraw" && !fresh.token_id) {
    return { ok: false, error: "缺少 NFT tokenId，无法平仓（该仓位可能是单币理财）" };
  }

  const r =
    action === "withdraw"
      ? await withdrawCalldata({
          chain: fresh.chain,
          investmentId: fresh.investment_id,
          address: fresh.address,
          tokenId: fresh.token_id,
          platformId: fresh.platform_id,
          ratio,
        })
      : await collectCalldata({
          chain: fresh.chain,
          address: fresh.address,
          platformId: fresh.platform_id,
          investmentId: fresh.investment_id,
          tokenId: fresh.token_id,
        });

  if (!r.ok) return { ok: false, error: `生成 calldata 失败：${r.error ?? "unknown"}` };

  const dataList = r.data?.dataList ?? [];
  if (!dataList.length) return { ok: false, error: "onchainos 未返回交易步骤（可能没有可领取的手续费）" };

  for (const s of dataList) {
    if (s.valueNormalizeError) return { ok: false, error: `交易数据异常（${s.valueNormalizeError}），已中止` };
  }

  const steps = dataList.map((s: any) => ({
    to: String(s.to),
    data: String(s.serializedData),
    value: String(s.valueNormalized ?? "0"),
  }));

  const token = randomBytes(18).toString("base64url");
  pending.set(token, {
    kind: action,
    planId: fresh.plan_id ?? "",
    positionId,
    steps,
    inputAmount: "0",
    inputToken: "",
    investmentId: String(fresh.investment_id),
    chain: fresh.chain,
    address: fresh.address,
    createdAt: Date.now(),
    used: false,
    completed: [],
    valueUsd: Number(fresh.value_usd ?? 0),
  });

  const preview = steps.map((s, i) => {
    const sel = s.data.slice(0, 10);
    // 0x095ea7b3 = ERC20 approve, 0xa22cb465 = ERC721 setApprovalForAll
    const kind = sel === "0x095ea7b3" ? "approve-erc20" : sel === "0xa22cb465" ? "approve-nft" : action;
    return { index: i, to: s.to, kind, dataLength: s.data.length };
  });

  let feesUsd = 0;
  try {
    const payload = fresh.plan_id
      ? JSON.parse(one<any>(`SELECT payload FROM plans WHERE id=?`, fresh.plan_id)?.payload ?? "null")
      : null;
    feesUsd = (payload?.__fees ?? []).reduce((s: number, f: any) => s + (Number(f.valueUsd) || 0), 0);
  } catch { /* ignore */ }

  return {
    ok: true,
    confirmToken: token,
    expiresInSec: TOKEN_TTL_MS / 1000,
    preview: {
      kind: action,
      positionId,
      pool: fresh.pool_name ?? "",
      chain: fresh.chain,
      address: fresh.address,
      tokenId: fresh.token_id,
      ratio,
      valueUsd: Number(fresh.value_usd ?? 0),
      feesUsd,
      steps: preview,
      estimatedGasNote: "X Layer 链上 gas 免费；每步依次确认后广播",
    },
  };
}

/* ── rebalance ─────────────────────────────── */

export interface RebalancePreview {
  kind: "rebalance_withdraw" | "rebalance_rebuild";
  positionId: string;
  pool: string;
  chain: string;
  halfWidthPct: number;
  fromTicks: { tickLower: number | null; tickUpper: number | null };
  toTicks: { tickLower: number; tickUpper: number };
  /** price bounds of the target range, for a human sanity check */
  targetPrices: { lower: number; upper: number };
  tokens: { symbol: string; amountHuman: string }[];
  steps: { index: number; to: string; kind: string; dataLength: number }[];
  estimatedGasNote: string;
  /** set when a previous rebalance was interrupted and this resumes it */
  resumed?: boolean;
}

export interface RebalancePrepareResult {
  ok: boolean;
  error?: string;
  confirmToken?: string;
  expiresInSec?: number;
  preview?: RebalancePreview;
}

/**
 * Step 1 of a rebalance: withdraw the whole position so its capital becomes
 * loose tokens, and persist the target range.
 *
 * The intent is written BEFORE any calldata is generated. If the withdraw
 * succeeds and the rebuild never happens, the stored intent is the only record
 * that capital is sitting in the wallet waiting to be redeployed — without it a
 * crash would look like the position simply vanished.
 */
export async function prepareRebalance(
  positionId: string,
  halfWidthPct: number,
): Promise<RebalancePrepareResult> {
  sweep();

  if (!(halfWidthPct > 0 && halfWidthPct <= 50)) {
    return { ok: false, error: "新区间宽度须在 (0, 50]% 之间" };
  }

  const { syncPositions } = await import("./portfolio.ts");
  const { computeTargetTicks, beginRebalance } = await import("./rebalance.ts");

  const pos = one<any>(`SELECT * FROM positions WHERE id=?`, positionId);
  if (!pos) return { ok: false, error: "仓位不存在" };
  if (pos.status !== "open") return { ok: false, error: "该仓位已平仓，无法调仓" };
  if (!pos.token_id) return { ok: false, error: "缺少 NFT tokenId，无法调仓" };

  await syncPositions(pos.chain, pos.address);
  const fresh = one<any>(`SELECT * FROM positions WHERE id=?`, positionId);
  if (!fresh) return { ok: false, error: "仓位同步失败" };

  let storedTokens: any[] = [];
  try { storedTokens = JSON.parse(fresh.tokens_json || "[]"); } catch { /* keep [] */ }
  if (!storedTokens.length) return { ok: false, error: "仓位没有可撤出的代币" };

  // The pool address lives on the plan payload. Without it we cannot price the
  // new range, and guessing from pool_name would risk rebalancing into the
  // wrong pool (names repeat across chains and fee tiers).
  const planRow = one<any>(`SELECT payload FROM plans WHERE id=?`, fresh.plan_id);
  let poolAddress: string | null = null;
  try {
    poolAddress = JSON.parse(planRow?.payload ?? "null")?.pool?.address ?? null;
  } catch {
    poolAddress = null;
  }
  if (!poolAddress) return { ok: false, error: "关联计划缺少池子地址，无法计算新区间" };

  // Compute the new range from the pool's CURRENT price. Re-using the old
  // plan's ticks would put the position right back where it was.
  const target = await computeTargetTicks({
    chain: fresh.chain,
    poolAddress,
    halfWidthPct,
  });
  if (!target.ok || !target.ticks) return { ok: false, error: target.error ?? "区间计算失败" };

  const tokens = storedTokens.map((t: any) => {
    const dec = Number(t.decimals ?? 18);
    const human = Number(t.amount ?? 0);
    return {
      symbol: String(t.symbol ?? ""),
      address: String(t.address ?? ""),
      amount: String(Math.floor(human * 10 ** dec)),
      decimals: dec,
      amountHuman: String(human),
    };
  });

  const intent = beginRebalance(positionId, halfWidthPct, target.ticks, tokens);

  const r = await withdrawCalldata({
    chain: fresh.chain,
    investmentId: fresh.investment_id,
    address: fresh.address,
    tokenId: fresh.token_id,
    platformId: fresh.platform_id,
    ratio: 1,
  });
  if (!r.ok) return { ok: false, error: `生成撤仓 calldata 失败：${r.error ?? "unknown"}` };

  const dataList = r.data?.dataList ?? [];
  if (!dataList.length) return { ok: false, error: "onchainos 未返回交易步骤" };
  for (const s of dataList) {
    if (s.valueNormalizeError) return { ok: false, error: `交易数据异常（${s.valueNormalizeError}），已中止` };
  }

  const steps = dataList.map((s: any) => ({
    to: String(s.to),
    data: String(s.serializedData),
    value: String(s.valueNormalized ?? "0"),
  }));

  const token = randomBytes(18).toString("base64url");
  pending.set(token, {
    kind: "rebalance_withdraw",
    planId: fresh.plan_id ?? "",
    positionId,
    steps,
    inputAmount: "0",
    inputToken: "",
    investmentId: String(fresh.investment_id),
    chain: fresh.chain,
    address: fresh.address,
    createdAt: Date.now(),
    used: false,
    completed: [],
    valueUsd: Number(fresh.value_usd ?? 0),
  });

  return {
    ok: true,
    confirmToken: token,
    expiresInSec: TOKEN_TTL_MS / 1000,
    preview: {
      kind: "rebalance_withdraw",
      positionId,
      pool: fresh.pool_name ?? "",
      chain: fresh.chain,
      halfWidthPct,
      fromTicks: {
        tickLower: Number.isFinite(Number(fresh.tick_lower)) ? Number(fresh.tick_lower) : null,
        tickUpper: Number.isFinite(Number(fresh.tick_upper)) ? Number(fresh.tick_upper) : null,
      },
      toTicks: { tickLower: intent.ticks.tickLower, tickUpper: intent.ticks.tickUpper },
      targetPrices: { lower: intent.ticks.priceLower, upper: intent.ticks.priceUpper },
      tokens: tokens.map((t) => ({ symbol: t.symbol, amountHuman: t.amountHuman })),
      steps: steps.map((s, i) => ({
        index: i,
        to: s.to,
        kind: s.data.slice(0, 10) === "0x095ea7b3" ? "approve-erc20"
          : s.data.slice(0, 10) === "0xa22cb465" ? "approve-nft" : "withdraw",
        dataLength: s.data.length,
      })),
      estimatedGasNote: "第 1/2 步：撤出旧区间。完成后需再确认一次以在新区间建仓。",
    },
  };
}

/**
 * Step 2 of a rebalance: put the released capital back into the new range.
 *
 * Both tokens go in as-is. Passing a single token would make the router swap
 * part of it at market, which changes what the position actually holds and
 * makes the cost basis meaningless.
 */
export async function prepareRebuild(positionId: string): Promise<RebalancePrepareResult> {
  sweep();

  const { syncPositions } = await import("./portfolio.ts");
  const { readIntent, buildDualTokenArgs } = await import("./rebalance.ts");

  const pos = one<any>(`SELECT * FROM positions WHERE id=?`, positionId);
  if (!pos) return { ok: false, error: "仓位不存在" };

  const intent = readIntent(positionId);
  if (!intent) return { ok: false, error: "没有待完成的调仓意图，请重新发起调仓" };
  if (intent.phase !== "rebuild") return { ok: false, error: "调仓第 1 步尚未完成" };

  const plan = one<any>(`SELECT payload FROM plans WHERE id=?`, pos.plan_id);
  if (!plan?.payload) return { ok: false, error: "找不到关联计划，无法确定池子" };
  const payload = JSON.parse(plan.payload);
  const pool = payload?.pool;
  if (!pool?.address) return { ok: false, error: "计划缺少池子地址" };

  const dual = buildDualTokenArgs(intent.tokens);
  if (!dual.ok) return { ok: false, error: dual.error ?? "无法构造双币参数" };

  const args = [
    "defi", "invest",
    "--investment-id", String(pos.investment_id),
    "--address", pos.address,
    "--chain", onchainosChain(pos.chain),
    "--token", dual.token,
    "--amount", dual.amount,
    "--slippage", "0.01",
    "--tick-lower", String(intent.ticks.tickLower),
    "--tick-upper", String(intent.ticks.tickUpper),
  ];
  if (dual.token2 && dual.amount2) args.push("--token2", dual.token2, "--amount2", dual.amount2);

  const r = await runOnchainos<any>(args, 90_000);
  if (!r.ok) return { ok: false, error: `生成建仓 calldata 失败：${r.error ?? "unknown"}` };

  const dataList = r.data?.dataList ?? [];
  if (!dataList.length) return { ok: false, error: "onchainos 未返回交易步骤" };
  for (const s of dataList) {
    if (s.valueNormalizeError) return { ok: false, error: `交易数据异常（${s.valueNormalizeError}），已中止` };
  }

  const steps = dataList.map((s: any) => ({
    to: String(s.to),
    data: String(s.serializedData),
    value: String(s.valueNormalized ?? "0"),
  }));

  const token = randomBytes(18).toString("base64url");
  pending.set(token, {
    kind: "rebalance_rebuild",
    planId: pos.plan_id ?? "",
    positionId,
    steps,
    inputAmount: dual.amount,
    inputToken: dual.token,
    investmentId: String(pos.investment_id),
    chain: pos.chain,
    address: pos.address,
    createdAt: Date.now(),
    used: false,
    completed: [],
    costUsd: intent.tokens.reduce((s, t) => s + Number(t.amountHuman), 0),
    legs: intent.tokens.map((t) => ({
      symbol: t.symbol, address: t.address, amountHuman: t.amountHuman, decimals: t.decimals,
    })),
  });

  return {
    ok: true,
    confirmToken: token,
    expiresInSec: TOKEN_TTL_MS / 1000,
    preview: {
      kind: "rebalance_rebuild",
      positionId,
      pool: pos.pool_name ?? "",
      chain: pos.chain,
      halfWidthPct: intent.halfWidthPct,
      fromTicks: { tickLower: null, tickUpper: null },
      toTicks: { tickLower: intent.ticks.tickLower, tickUpper: intent.ticks.tickUpper },
      targetPrices: { lower: intent.ticks.priceLower, upper: intent.ticks.priceUpper },
      tokens: intent.tokens.map((t) => ({ symbol: t.symbol, amountHuman: t.amountHuman })),
      steps: steps.map((s, i) => ({
        index: i,
        to: s.to,
        kind: s.data.slice(0, 10) === "0x095ea7b3" ? "approve-erc20" : "deposit",
        dataLength: s.data.length,
      })),
      estimatedGasNote: "第 2/2 步：在新区间建仓",
      resumed: true,
    },
  };
}
