/**
 * Chain configuration.
 *
 * Phase 1 targets X Layer, where the account actually holds funds, instead of
 * Base. The chain must not be hardcoded anywhere else: a data source id, a
 * GeckoTerminal path segment, and an onchainos chain name are three different
 * spellings of the same network, and they diverge (x-layer vs xlayer). Keeping
 * the mapping in one place is the only way this stays correct.
 */

export interface ChainConfig {
  /** our internal key */
  key: string;
  /** GeckoTerminal network id (used in API paths) */
  gecko: string;
  /** onchainos --chain value */
  onchainos: string;
  /** EVM chain id */
  chainId: number;
  label: string;
  /** native gas token symbol */
  nativeSymbol: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  "x-layer": {
    key: "x-layer",
    gecko: "x-layer",
    onchainos: "xlayer",
    chainId: 196,
    label: "X Layer",
    nativeSymbol: "OKB",
  },
  base: {
    key: "base",
    gecko: "base",
    onchainos: "base",
    chainId: 8453,
    label: "Base",
    nativeSymbol: "ETH",
  },
  ethereum: {
    key: "ethereum",
    gecko: "eth",
    onchainos: "ethereum",
    chainId: 1,
    label: "Ethereum",
    nativeSymbol: "ETH",
  },
  arbitrum: {
    key: "arbitrum",
    gecko: "arbitrum",
    onchainos: "arbitrum",
    chainId: 42161,
    label: "Arbitrum",
    nativeSymbol: "ETH",
  },
};

/** Phase 1 default. Override with LP_CHAIN. */
export const DEFAULT_CHAIN = process.env.LP_CHAIN && CHAINS[process.env.LP_CHAIN]
  ? process.env.LP_CHAIN
  : "x-layer";

export function chainConfig(key?: string | null): ChainConfig {
  return CHAINS[key ?? DEFAULT_CHAIN] ?? CHAINS[DEFAULT_CHAIN];
}

/** GeckoTerminal API path segment. */
export function geckoNetwork(key?: string | null): string {
  return chainConfig(key).gecko;
}

/** GeckoTerminal public site path segment (differs from API id for ethereum). */
export function geckoSitePath(key?: string | null): string {
  const k = chainConfig(key).key;
  return k === "ethereum" ? "eth" : k;
}

/** onchainos CLI --chain value. */
export function onchainosChain(key?: string | null): string {
  return chainConfig(key).onchainos;
}

export function chainLabel(key?: string | null): string {
  return chainConfig(key).label;
}

export function isSupportedChain(key: string): boolean {
  return Boolean(CHAINS[key]);
}
