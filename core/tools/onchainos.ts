/**
 * onchainos bridge.
 *
 * The CLI is the only sanctioned path to OKX's DeFi backend, so this module is
 * deliberately thin: build argv arrays (never shell strings), run, parse JSON.
 *
 * Two arg-naming traps in the CLI that cost real debugging time:
 *   - `defi calculate-entry` takes `--id`
 *   - `defi deposit` / `prepare` / `detail` take `--investment-id`
 * Passing the wrong one fails with a usage error, not a useful message.
 *
 * Also: `--user-input` for deposit wants HUMAN units ("0.05"), while
 * `--input-amount` for calculate-entry wants MINIMAL units ("50000").
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DEFAULT_CHAIN, onchainosChain, chainConfig } from "../config.ts";

const BIN_CANDIDATES = [
  process.env.ONCHAINOS_BIN,
  join(homedir(), ".local", "bin", "onchainos"),
  "/usr/local/bin/onchainos",
].filter(Boolean) as string[];

export function onchainosBin(): string | null {
  for (const p of BIN_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export function isInstalled(): boolean {
  return onchainosBin() !== null;
}

export interface CliResult<T = any> {
  ok: boolean;
  data: T | null;
  raw: string;
  error?: string;
  tookMs: number;
  /** process exit code; 2 means "confirming" for state-changing commands */
  exitCode?: number;
  /**
   * True when the CLI wants an explicit human confirmation before broadcasting.
   * The transaction has NOT been signed or sent in this state.
   */
  confirming?: boolean;
  /** prompt to show the user when confirming */
  message?: string;
  /** follow-up the CLI expects after the user confirms (usually same args + --force) */
  next?: unknown;
}

/** Run a subcommand. Args are an array — no shell, no quoting bugs. */
export function runOnchainos<T = any>(args: string[], timeoutMs = 60_000): Promise<CliResult<T>> {
  const started = Date.now();
  const bin = onchainosBin();
  if (!bin) {
    return Promise.resolve({ ok: false, data: null, raw: "", error: "onchainos not installed", tookMs: 0 });
  }

  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = String(stdout ?? "");
      const errText = String(stderr ?? "");
      const exitCode = err ? Number((err as any).code ?? 1) : 0;

      // Parse stdout BEFORE deciding success. State-changing commands return
      // JSON with `confirming: true` and exit code 2 — that is a *pending user
      // confirmation*, not a failure and emphatically not a broadcast. Treating
      // exit code 2 as a hard error would report a successful deposit as failed;
      // treating it as success would claim a position that was never opened.
      let parsed: any = null;
      if (raw.trim()) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
      }

      if (parsed && (parsed.confirming === true || exitCode === 2)) {
        resolve({
          ok: true,
          data: parsed.data ?? null,
          raw,
          tookMs: Date.now() - started,
          exitCode,
          confirming: true,
          message: String(parsed.message ?? parsed.data?.message ?? "需要确认"),
          next: parsed.next ?? null,
        });
        return;
      }

      if (err) {
        // SIGABRT happens when the CLI's SIGPIPE fires; keep it explicit so it
        // is not mistaken for a data error.
        const code = (err as any).code ?? (err as any).signal ?? "unknown";
        const detail = parsed?.error ?? errText ?? (err as Error).message ?? "";
        resolve({
          ok: false, data: null, raw: raw || errText,
          error: `${code}: ${String(detail).slice(0, 300)}`,
          tookMs: Date.now() - started,
          exitCode,
        });
        return;
      }

      if (parsed) {
        const ok = parsed.ok !== false;
        resolve({
          ok,
          data: parsed.data ?? parsed,
          raw,
          error: ok ? undefined : String(parsed.error ?? "onchainos returned ok:false"),
          tookMs: Date.now() - started,
          exitCode,
        });
        return;
      }

      resolve({
        ok: false, data: null, raw: raw || errText,
        error: `non-JSON output: ${(raw || errText).slice(0, 300)}`,
        tookMs: Date.now() - started,
        exitCode,
      });
    });
  });
}

/* ── wallet ───────────────────────────────── */

export interface WalletStatus {
  loggedIn: boolean;
  accountCount: number;
  accountId?: string;
  accountName?: string;
  email?: string;
  evmAddress?: string;
}

export async function walletStatus(): Promise<WalletStatus> {
  const r = await runOnchainos<any>(["wallet", "status"], 30_000);
  const d = r.data ?? {};
  return {
    loggedIn: Boolean(d.loggedIn),
    accountCount: Number(d.accountCount ?? 0),
    accountId: d.currentAccountId || undefined,
    accountName: d.currentAccountName || undefined,
    email: d.email || undefined,
  };
}

export async function walletAddresses(chain: string = DEFAULT_CHAIN): Promise<string[]> {
  const r = await runOnchainos<any>(["wallet", "addresses", "--chain", onchainosChain(chain)], 30_000);
  const d = r.data ?? {};
  // With `--chain xlayer` the address comes back under a `xlayer` key, NOT under
  // `evm`. Reading only `evm` silently yields [] and every downstream call gets
  // an empty `--address`. Collect from every address array instead.
  const out: string[] = [];
  for (const [k, v] of Object.entries<any>(d)) {
    if (!Array.isArray(v)) continue;
    if (!(k === "evm" || k === "xlayer" || k === "bitcoin" || k === "solana" || k === "sui")) continue;
    for (const entry of v) {
      const addr = typeof entry === "string" ? entry : entry?.address;
      if (addr && !out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

export interface ChainBalance {
  chain: string;
  totalValueUsd: number;
  tokens: { symbol: string; address: string; balance: string; decimals: number; usd: number }[];
}

/**
 * Balance shape differs between `--chain` and `--all`:
 *   --chain → data.details[].tokenAssets[]
 *   --all   → data.details.<accountId>.data[].tokenAssets[]
 * Both are handled because the funding check must not silently read 0.
 */
export async function chainBalance(chain: string): Promise<ChainBalance> {
  const r = await runOnchainos<any>(["wallet", "balance", "--chain", onchainosChain(chain)], 45_000);
  const tokens: ChainBalance["tokens"] = [];

  const push = (a: any) => {
    if (!a || typeof a !== "object") return;
    tokens.push({
      symbol: a.symbol ?? "?",
      address: a.tokenAddress ?? "",
      balance: String(a.balance ?? "0"),
      decimals: Number(a.decimal ?? 18),
      usd: Number(a.usdValue ?? 0),
    });
  };

  const details = r.data?.details;
  if (Array.isArray(details)) {
    for (const d of details) for (const a of d?.tokenAssets ?? []) push(a);
  } else if (details && typeof details === "object") {
    for (const acct of Object.values<any>(details)) {
      for (const grp of acct?.data ?? []) for (const a of grp?.tokenAssets ?? []) push(a);
    }
  }

  return {
    chain,
    totalValueUsd: Number(r.data?.totalValueUsd ?? 0),
    tokens,
  };
}

/* ── defi ─────────────────────────────────── */

export interface DexPoolCandidate {
  investmentId: number;
  name: string;
  platformName: string;
  feeRate: number;
  tvl: number;
  rate: number;
  chainIndex: string;
}

export async function searchDexPools(chain: string, tokenKeyword: string): Promise<DexPoolCandidate[]> {
  const r = await runOnchainos<any>(
    ["defi", "search", "--chain", onchainosChain(chain), "--product-group", "DEX_POOL", "--token", tokenKeyword],
    45_000,
  );
  const list = r.data?.list ?? [];
  return list.map((x: any) => ({
    investmentId: Number(x.investmentId),
    name: String(x.name ?? ""),
    platformName: String(x.platformName ?? ""),
    feeRate: Number(x.feeRate ?? 0),
    tvl: Number(x.tvl ?? 0),
    rate: Number(x.rate ?? 0),
    chainIndex: String(x.chainIndex ?? ""),
  }));
}

export interface PoolDetail {
  investmentId: number;
  name: string;
  platformName: string;
  feeRate: number;
  tvl: number;
  rate: number;
  chainIndex: string;
  isInvestable: boolean;
  contract: string | null;
  poolVersion: number | null;
  tokens: { symbol: string; address: string; isBase: boolean }[];
}

export async function poolDetailById(chain: string, investmentId: number | string): Promise<PoolDetail | null> {
  const r = await runOnchainos<any>(
    ["defi", "detail", "--investment-id", String(investmentId), "--chain", onchainosChain(chain)],
    45_000,
  );
  const d = r.data;
  if (!d) return null;
  return {
    investmentId: Number(d.investmentId ?? investmentId),
    name: String(d.investmentName ?? d.investmentShowName ?? ""),
    platformName: String(d.platformName ?? ""),
    feeRate: Number(d.feeRate ?? 0),
    tvl: Number(d.tvl ?? 0),
    rate: Number(d.rate ?? 0),
    chainIndex: String(d.chainIndex ?? ""),
    isInvestable: Boolean(d.isInvestable),
    contract: d.contract ?? null,
    poolVersion: d.poolVersion !== undefined ? Number(d.poolVersion) : null,
    tokens: (d.underlyingToken ?? []).map((t: any) => ({
      symbol: String(t.tokenSymbol ?? ""),
      address: String(t.tokenAddress ?? "").toLowerCase(),
      isBase: Boolean(t.isBaseToken),
    })),
  };
}

/**
 * Canonical symbol form for cross-source matching.
 *
 * The two data sources name the same token differently:
 *   GeckoTerminal: "USDC / wTSLAx", "USDC / USD₮0", "WETH / USDC"
 *   onchainos:     "TSLAx-USDC",   "USDT-USDC",    "ETH-USDC"
 * Matching raw strings finds nothing. Normalize both sides to the same form:
 *   - uppercase
 *   - USD₮0 / USD₮ / USDT₮ -> USDT (the tether sign)
 *   - drop the leading "w" of wrapped/tokenized assets (WETH, wTSLAx)
 *   - strip a trailing "x" only if the other side lacks it (handled by trying both)
 */
export function normalizeSymbol(s: string): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/₮/g, "T")
    .replace(/\s+/g, "")
    .replace(/^W(?=[A-Z])/, "");
}

/** True when two symbols refer to the same asset under different naming. */
export function symbolsMatch(a: string, b: string): boolean {
  const na = normalizeSymbol(a);
  const nb = normalizeSymbol(b);
  if (na === nb) return true;
  // tokenized-stock suffix: "TSLAX" vs "TSLA"
  if (na.replace(/X$/, "") === nb.replace(/X$/, "")) return true;
  // tether variants: USDT / USDT0
  if (na.replace(/0$/, "") === nb.replace(/0$/, "")) return true;
  return false;
}

/**
 * Find the OKX investmentId for a pool we already know from our own data.
 *
 * Name matching alone is unsafe: "ETH-USDC" exists at 0.01%, 0.05%, 0.3%, and
 * multiple TVL versions. So we require BOTH the fee rate and the token pair to
 * agree, then prefer the candidate whose TVL is closest to ours (same pool seen
 * at a slightly different snapshot time).
 */
export async function resolveInvestmentId(params: {
  chain: string;
  baseSymbol: string;
  quoteSymbol: string;
  feeTierPct: number | null;
  tvlUsd?: number | null;
}): Promise<{
  ok: boolean;
  investmentId?: number;
  candidate?: PoolDetail;
  considered: number;
  error?: string;
}> {
  const feeRate = params.feeTierPct !== null ? params.feeTierPct / 100 : null;
  const want = new Set([params.baseSymbol.toUpperCase(), params.quoteSymbol.toUpperCase()]);

  // Search by BOTH tokens, not just the base. The backend caps each query at
  // 20 results, so one keyword can miss the pair entirely (e.g. "USDC" returns
  // 20 unrelated pairs on X Layer while the USDG pairing sits outside the page).
  const rawKeywords = [params.baseSymbol, params.quoteSymbol];
  const keywords = [...new Set(rawKeywords.flatMap((s) => [s, s.replace(/^W/, "")]))].filter(Boolean);

  const seen = new Map<number, DexPoolCandidate>();
  for (const kw of keywords) {
    const list = await searchDexPools(params.chain, kw);
    for (const c of list) if (!seen.has(c.investmentId)) seen.set(c.investmentId, c);
  }

  const candidates = [...seen.values()].filter((c) => {
    if (feeRate !== null && Math.abs(c.feeRate - feeRate) > 1e-9) return false;
    const parts = c.name.split(/[-/]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return false;
    return (
      parts.some((p) => symbolsMatch(p, params.baseSymbol)) &&
      parts.some((p) => symbolsMatch(p, params.quoteSymbol))
    );
  });

  if (!candidates.length) {
    return {
      ok: false,
      considered: seen.size,
      error: `onchainos 未收录该池子（已检查 ${seen.size} 个候选），无法通过它下单`,
    };
  }

  // prefer the closest TVL to ours: same pool, different snapshot
  candidates.sort((a, b) => {
    if (params.tvlUsd == null) return b.tvl - a.tvl;
    return Math.abs(a.tvl - params.tvlUsd) - Math.abs(b.tvl - params.tvlUsd);
  });

  const pick = candidates[0];
  const detail = await poolDetailById(params.chain, pick.investmentId);

  // verify the token pair from the authoritative detail payload
  if (detail) {
    const syms = detail.tokens.map((t) => t.symbol);
    const hasBase = syms.some((s) => symbolsMatch(s, params.baseSymbol));
    const hasQuote = syms.some((s) => symbolsMatch(s, params.quoteSymbol));
    if (!(hasBase && hasQuote)) {
      return {
        ok: false,
        considered: candidates.length,
        candidate: detail,
        error: `token mismatch: detail has ${syms.join("/")}, wanted ${params.baseSymbol}/${params.quoteSymbol}`,
      };
    }
  }

  return { ok: true, investmentId: pick.investmentId, candidate: detail ?? undefined, considered: candidates.length };
}

export async function calculateEntry(params: {
  chain: string;
  investmentId: number | string;
  address: string;
  inputToken: string;
  /** minimal units, e.g. 5000000 for 5 USDC (6 decimals) */
  inputAmount: string;
  tokenDecimals: number;
  tickLower: number;
  tickUpper: number;
}) {
  return runOnchainos<any>(
    [
      "defi", "calculate-entry",
      "--id", String(params.investmentId),
      "--address", params.address,
      "--chain", onchainosChain(params.chain),
      "--input-token", params.inputToken,
      "--input-amount", String(params.inputAmount),
      "--token-decimal", String(params.tokenDecimals),
      "--tick-lower", String(params.tickLower),
      "--tick-upper", String(params.tickUpper),
    ],
    60_000,
  );
}

/* ── positions ─────────────────────────────── */

/**
 * One LP position as we present it.
 *
 * The raw payload nests six levels deep (data[].walletIdPlatformDetailList[]
 * .networkHoldVoList[].investTokenBalanceVoList[].positionList[]), and the
 * fields we actually need are spread across those levels: platformName lives
 * at the top, investmentId one level down, tokenId at the bottom. Flattening
 * once here keeps every caller from re-walking that tree.
 */
export interface LpPosition {
  /** onchainos investment id (used by withdraw) */
  investmentId: number;
  /** Uniswap V3 NFT id; required for withdraw so the right position is hit */
  tokenId: string | null;
  /** analysis platform id; withdraw needs it to refresh position detail */
  platformId: number;
  platformName: string;
  chain: string;
  chainIndex: string;
  /** "USDG-USDT" */
  name: string;
  /** total position value in USD */
  valueUsd: number;
  tokens: { symbol: string; address: string; amount: number; decimals: number; valueUsd: number }[];
  /** unclaimed trading fees */
  fees: { symbol: string; address: string; amount: number; valueUsd: number }[];
  /** IN RANGE / OUT OF RANGE etc. */
  status: string;
  range: { lowerPrice: number | null; upperPrice: number | null; tickLower: number | null; tickUpper: number | null; text: string | null };
  feeRate: number | null;
  detailPath: string | null;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Flatten a `defi position-detail` payload into LpPosition[]. */
export function flattenPositions(raw: any, chain: string): LpPosition[] {
  const out: LpPosition[] = [];
  const groups = Array.isArray(raw) ? raw : [];
  for (const g of groups) {
    const platformId = Number(g?.analysisPlatformId ?? 0);
    const platformName = String(g?.platformName ?? "");
    for (const w of g?.walletIdPlatformDetailList ?? []) {
      for (const h of w?.networkHoldVoList ?? []) {
        const chainIndex = String(h?.chainIndex ?? "");
        for (const it of h?.investTokenBalanceVoList ?? []) {
          const valueUsd = numOrNull(it?.totalValue) ?? 0;
          const feeRate = numOrNull(it?.feeRate);
          const positions = it?.positionList ?? [];

          const mapTokens = (list: any[]) =>
            (list ?? []).map((t: any) => ({
              symbol: String(t?.tokenSymbol ?? ""),
              address: String(t?.tokenAddress ?? ""),
              amount: numOrNull(t?.coinAmount) ?? 0,
              decimals: numOrNull(t?.tokenPrecision) ?? 18,
              valueUsd: numOrNull(t?.currencyAmount) ?? 0,
            }));

          const push = (pl: any, tokenId: string | null) => {
            // Token amounts live on the POSITION, not on the holding wrapper:
            // it.assetsTokenList is empty for V3 pools, the real split is at
            // positionList[i].assetsTokenList.
            const tokens = mapTokens(pl?.assetsTokenList ?? it?.assetsTokenList ?? []);
            const fees: LpPosition["fees"] = [];
            for (const f of pl?.unclaimFeesDefiTokenInfo ?? []) {
              for (const t of f?.baseDefiTokenInfos ?? []) {
                const amt = numOrNull(t?.coinAmount) ?? 0;
                if (amt > 0) {
                  fees.push({
                    symbol: String(t?.tokenSymbol ?? ""),
                    address: String(t?.tokenAddress ?? ""),
                    amount: amt,
                    valueUsd: numOrNull(t?.currencyAmount) ?? 0,
                  });
                }
              }
            }
            const ri = pl?.rangeInfo ?? {};
            out.push({
              investmentId: Number(it?.investmentId ?? 0),
              tokenId,
              platformId,
              platformName,
              chain,
              chainIndex,
              name: String(it?.investmentName ?? pl?.positionName ?? ""),
              valueUsd: numOrNull(pl?.totalValue) ?? valueUsd,
              tokens,
              fees,
              status: String(pl?.positionStatus ?? (positions.length ? "ACTIVE" : "UNKNOWN")),
              range: {
                lowerPrice: numOrNull(ri?.lowerPrice),
                upperPrice: numOrNull(ri?.upperPrice),
                tickLower: numOrNull(ri?.tickLower),
                tickUpper: numOrNull(ri?.tickUpper),
                text: pl?.range ? String(pl.range) : null,
              },
              feeRate,
              detailPath: it?.detailPath ? String(it.detailPath) : null,
            });
          };

          if (positions.length) {
            for (const pl of positions) push(pl, pl?.tokenId != null ? String(pl.tokenId) : null);
          } else {
            // lending / single-earn holdings have no NFT and no positionList
            push(null, null);
          }
        }
      }
    }
  }
  return out;
}

/** Coarse holdings overview (protocol totals). Used for a quick header total. */
export async function positionsOverview(chain: string, address: string) {
  return runOnchainos<any>(["defi", "positions", "--address", address, "--chains", String(chainConfig(chain).chainId)], 60_000);
}

/**
 * Detailed positions for one venue. onchainos requires --platform-id here, so a
 * wallet holding several protocols needs one call per protocol.
 */
export async function positionDetailByPlatform(chain: string, address: string, platformId: number | string) {
  return runOnchainos<any>(
    ["defi", "position-detail", "--address", address, "--chain", onchainosChain(chain), "--platform-id", String(platformId)],
    60_000,
  );
}

/** Platform ids that currently hold something, so we know what to drill into. */
export async function platformIdsWithHoldings(chain: string, address: string): Promise<number[]> {
  const r = await positionsOverview(chain, address);
  const ids = new Set<number>();
  for (const w of r.data?.walletIdPlatformList ?? []) {
    for (const p of w?.platformList ?? []) {
      const id = Number(p?.analysisPlatformId);
      if (Number.isFinite(id) && Number(p?.investmentCount ?? 0) > 0) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * All LP positions on a chain, fully flattened.
 *
 * Two calls minimum: an overview to discover which platforms hold something,
 * then a detail call per platform. Skipping the overview means guessing
 * platform ids; skipping detail leaves us without tokenId, which withdraw
 * needs.
 */
export async function listPositions(chain: string, address: string): Promise<{
  ok: boolean;
  error?: string;
  positions: LpPosition[];
}> {
  const ids = await platformIdsWithHoldings(chain, address);
  if (!ids.length) return { ok: true, positions: [] };

  const positions: LpPosition[] = [];
  const errors: string[] = [];

  for (const pid of ids) {
    const r = await positionDetailByPlatform(chain, address, pid);
    if (!r.ok) {
      errors.push(`platform ${pid}: ${r.error ?? "unknown"}`);
      continue;
    }
    positions.push(...flattenPositions(r.data, chain));
  }

  // a partial failure must be visible, not silently dropped
  return {
    ok: errors.length === 0,
    error: errors.length ? errors.join("; ") : undefined,
    positions,
  };
}

/* ── withdraw ──────────────────────────────── */

/**
 * Build exit calldata. Returns UNSIGNED steps, exactly like `defi invest`.
 *
 * `--token-id` is mandatory for V3: one wallet can hold several positions in
 * the same pool, and without the NFT id the CLI would either fail or target
 * the wrong one. `--platform-id` lets the CLI refresh position detail itself;
 * the docs make position-detail a mandatory pre-step for withdraw, so passing
 * it here is what makes the calldata reflect current on-chain amounts.
 */
export async function withdrawCalldata(params: {
  chain: string;
  investmentId: number | string;
  address: string;
  tokenId?: string | null;
  platformId?: number | string | null;
  /** 1 = full exit, 0.5 = half */
  ratio?: number;
  slippage?: string;
}) {
  const args = [
    "defi", "withdraw",
    "--investment-id", String(params.investmentId),
    "--address", params.address,
    "--chain", onchainosChain(params.chain),
    "--ratio", String(params.ratio ?? 1),
    "--slippage", params.slippage ?? "0.01",
  ];
  if (params.tokenId) args.push("--token-id", String(params.tokenId));
  if (params.platformId != null) args.push("--platform-id", String(params.platformId));
  return runOnchainos<any>(args, 90_000);
}

/** Claim accrued trading fees for a V3 position. */
export async function collectCalldata(params: {
  chain: string;
  address: string;
  platformId: number | string;
  investmentId: number | string;
  tokenId?: string | null;
  rewardType?: string;
}) {
  const args = [
    "defi", "collect",
    "--address", params.address,
    "--chain", onchainosChain(params.chain),
    "--reward-type", params.rewardType ?? "REWARD_INVESTMENT",
    "--investment-id", String(params.investmentId),
    "--platform-id", String(params.platformId),
  ];
  if (params.tokenId) args.push("--token-id", String(params.tokenId));
  return runOnchainos<any>(args, 90_000);
}
