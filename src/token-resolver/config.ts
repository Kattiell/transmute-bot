/**
 * Tunable knobs for the token resolver. Every threshold lives here so behavior
 * can be adjusted without touching logic. See README in this folder.
 *
 * Policy (owner-mandated): a contract with NO official X (Twitter) profile tied
 * to it is CUT — never confirmed. The X-handle match between the narrative's
 * official @handle and the DEX-declared social is the primary anti-clone signal.
 */

export interface ResolverConfig {
  /** HARD GATE: confirmed REQUIRES the contract's DEX-declared X handle to match
   *  the narrative's official @handle. No match anywhere → abstained. */
  requireXMatch: boolean;

  /** Confidence thresholds. */
  confirmThreshold: number; // >= → confirmed (also needs zero critical flags + X match)
  lowConfidenceThreshold: number; // >= → low_confidence; below → abstained

  /** Confidence weights (summed, then clamped to [0,1]). */
  weights: {
    xMatch: number; // narrative X handle == DEX X handle (strongest)
    crossSource: number; // CA present in >= 2 independent sources (DexScreener + GeckoTerminal/CoinGecko/BaseScan)
    curated: number; // present in a curated list (CoinGecko verified)
    verifiedContract: number; // source code verified on BaseScan
    healthyMarket: number; // liquidity + age + holders look healthy (weak; wash-tradeable)
  };

  /** Market sanity (weak signals only — liquidity/volume are forgeable). */
  minLiquidityUsd: number; // below → low_liquidity flag
  youngPoolHours: number; // below → young_pool flag

  /** Security thresholds. */
  maxSellTaxPct: number; // above → high_sell_tax (critical)
  topHolderMaxPct: number; // top non-LP/burn holder above → top_holder_concentration (critical)
}

export const DEFAULT_CONFIG: ResolverConfig = {
  requireXMatch: true,
  confirmThreshold: 0.8,
  lowConfidenceThreshold: 0.5,
  weights: {
    xMatch: 0.6,
    crossSource: 0.3,
    curated: 0.2,
    verifiedContract: 0.1,
    healthyMarket: 0.1,
  },
  minLiquidityUsd: 10_000,
  youngPoolHours: 24,
  maxSellTaxPct: 10,
  topHolderMaxPct: 50,
};

/** Flags that, if present, BLOCK `confirmed` regardless of confidence (I4 / safety-first). */
export const CRITICAL_FLAGS = new Set([
  'honeypot',
  'cannot_sell',
  'high_sell_tax',
  'top_holder_concentration',
  'mint_authority_active',
  'freeze_authority_active',
] as const);
