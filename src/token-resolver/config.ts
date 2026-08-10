/**
 * Tunable knobs for the token resolver. Every threshold lives here so behavior
 * can be adjusted without touching logic. See README in this folder.
 *
 * Policy (owner-mandated): a contract with NO official X (Twitter) profile tied
 * to it is CUT — never confirmed.
 *
 * HOW THAT POLICY IS ENFORCED CHANGED with the move to `openai-gpt-55-pro`.
 * The old gate compared the DEX-declared handle against the @ the MODEL wrote
 * in its narrative; that only worked because Grok had native X search to look
 * the handle up. GPT-5.5 has web search but no X search, so a
 * narrative-dependent gate would abstain on nearly everything.
 *
 * The gate is now tool-vs-tool (see `xhandle.ts`): the handle must be declared
 * by at least one independent registry (DEX token profile / GeckoTerminal /
 * CoinGecko), and if two registries name DIFFERENT accounts the signal is cut
 * as a probable clone. The narrative match survives as a confidence bonus, and
 * can be restored as a hard gate via `requireNarrativeXMatch`.
 */

export interface ResolverConfig {
  /** HARD GATE: at least one TOOL source must declare an official X handle for
   *  the contract. Nothing declared → abstained. (Tool sources only — the
   *  model's narrative never satisfies this.) */
  requireXHandle: boolean;

  /** HARD GATE: two tool sources naming different handles → abstained.
   *  Strongest clone signal available without X search; keep this on. */
  cutOnHandleConflict: boolean;

  /** LEGACY HARD GATE (default OFF): additionally require the tool-resolved
   *  handle to appear in the model's narrative. Only meaningful on a model
   *  with native X search — turning it on under GPT-5.5 will abstain on most
   *  signals. */
  requireNarrativeXMatch: boolean;

  /** Consult the search-model panel (xhandle-ai.ts) when the registries left a
   *  gap or disagreed. Off → those signals are simply cut, as before. A
   *  panel-resolved handle can never reach `confirmed` either way. */
  aiHandleFallback: boolean;

  /** Confidence thresholds. */
  confirmThreshold: number; // >= → confirmed (also needs zero critical flags + X match)
  lowConfidenceThreshold: number; // >= → low_confidence; below → abstained

  /** Confidence weights (summed, then clamped to [0,1]). */
  weights: {
    xHandle: number; // >= 1 tool source declares an official X for the contract
    xMultiSource: number; // >= 2 tool sources agree on the SAME handle (strongest)
    xMatch: number; // the model's narrative independently names the same handle
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
  requireXHandle: true,
  cutOnHandleConflict: true,
  requireNarrativeXMatch: false,
  aiHandleFallback: true,
  confirmThreshold: 0.8,
  lowConfidenceThreshold: 0.5,
  weights: {
    // A tool-declared handle is the baseline (it is also a hard gate, so every
    // surviving candidate scores it); agreement across registries is what
    // actually separates a verified identity from a single unverified claim.
    xHandle: 0.35,
    xMultiSource: 0.25,
    xMatch: 0.15,
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
