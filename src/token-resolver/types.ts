/**
 * Token-resolver — hardens "right token, wrong/scam address" out of the pipeline.
 *
 * Core rule: a contract address (CA) is identity ONLY as the pair (chainId,
 * address), and it may exist in the system ONLY if it came from a deterministic
 * tool/API payload — never from LLM-generated text. The LLM supplies INTENT
 * (symbol, official @handle, links); a deterministic resolver finds the CA and
 * the decision layer returns a confirmed CA or abstains. Never a guess.
 *
 * Scope: EVM / Base (8453). Structured for future chains, but Solana tooling is
 * intentionally out of scope here.
 */

/** Numeric EVM chain id. Base is the only supported chain in v1. */
export const BASE_CHAIN_ID = 8453;

export type SecurityFlag =
  | 'honeypot'
  | 'cannot_sell'
  | 'high_sell_tax'
  | 'mint_authority_active' // reserved for non-EVM; never set on EVM
  | 'freeze_authority_active' // reserved for non-EVM
  | 'lp_unlocked'
  | 'lp_not_burned'
  | 'top_holder_concentration'
  | 'ownership_not_renounced'
  | 'young_pool'
  | 'low_liquidity'
  | 'no_security_data';

/**
 * Camada 1 output. INTENT only — no trusted address. `modelCa` is whatever CA
 * the model leaked in its text; it is kept ONLY for a cross-check and is NEVER
 * propagated as the canonical address (invariant I1).
 */
export interface GrokIntent {
  symbol: string | null; // ticker, no leading '$'
  name: string | null;
  /** Official project/creator X (Twitter) handles from the narrative, lowercased, no '@'. */
  officialXHandles: string[];
  /** Any URLs the context treats as official (twitter/site). */
  officialLinks: string[];
  chainHint: number | null; // numeric chain id, e.g. 8453
  /** UNTRUSTED — a CA the model emitted in text. Cross-check only. May be null. */
  modelCa: string | null;
}

/** A resolved candidate, keyed by (chainId, address). Address ALWAYS from a tool. */
export interface Candidate {
  chainId: number;
  address: `0x${string}`; // EIP-55 canonical
  symbol: string;
  name?: string;
  /** APIs where THIS exact (chainId,address) appeared. */
  sources: string[];
  /** X/Twitter handle declared on-chain/by the DEX for this contract (lowercased, no '@'). */
  dexXHandle: string | null;
  /** Website domains declared by the DEX for this contract. */
  dexDomains: string[];
  /** Did the DEX-declared official X handle match the narrative's official handle? */
  socialsMatched: boolean;
  /** Present in a curated list (CoinGecko verified / etc.). */
  curated: boolean;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  ageHours: number | null;
  holders: number | null;
}

/** The ONLY currency of exchange after Camada 2. No function downstream accepts `symbol` to identify a token. */
export interface TokenRef {
  chainId: number;
  address: string; // canonical, format-validated
  symbol: string;
  name?: string;
  sources: string[];
  socialsMatched: boolean;
  confidence: number; // 0..1
  flags: SecurityFlag[];
  status: 'confirmed' | 'low_confidence' | 'abstained';
  reason?: string;
}

/** Structured, auditable log line emitted per resolution ("why this CA?"). */
export interface ResolutionLog {
  input: { symbol: string | null; handle: string | null; chainHint: number | null; modelCa: string | null };
  candidates: Array<{
    chainId: number;
    address: string;
    sources: string[];
    socialsMatched: boolean;
    curated: boolean;
    liquidityUsd: number | null;
  }>;
  chosen: { address: string; confidence: number; flags: SecurityFlag[] } | null;
  decision: TokenRef['status'];
  reason?: string;
}
