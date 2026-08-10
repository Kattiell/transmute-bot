/**
 * Camada 5 — confidence scoring + decision. Abstain beats guess (I3).
 *
 * Identity gates run before anything else:
 *   1. a contract with NO official X from ANY source — registry or model panel
 *      — is CUT (owner policy);
 *   2. a contract whose registries name DIFFERENT official X accounts, with no
 *      panel tie-break, is CUT as a probable clone.
 *
 * And one ceiling: a handle backed ONLY by the model panel (`ai-resolved`) or
 * by a broken tie (`contested`) can never reach `confirmed`, however well the
 * rest of the candidate scores. Registries prove identity; models corroborate.
 *
 * Any critical security flag, or missing security data, also blocks `confirmed`.
 */

import { CRITICAL_FLAGS, type ResolverConfig } from './config';
import type { Candidate, SecurityFlag, TokenRef } from './types';
import {
  handleConflictReason,
  handleProvenance,
  isModelBackedOnly,
  type XHandleVerdict,
} from './xhandle';

const CRITICAL_REASON: Partial<Record<SecurityFlag, string>> = {
  honeypot: 'Flagged as a honeypot.',
  cannot_sell: 'Simulation says the token cannot be sold.',
  high_sell_tax: 'Sell tax above the safe threshold.',
  top_holder_concentration: 'Top holder concentration above the safe threshold.',
};

export function decide(
  candidate: Candidate,
  securityFlags: SecurityFlag[],
  config: ResolverConfig,
  opts?: {
    modelCaMatchesChosen?: boolean;
    /** Result of the tool-vs-tool @handle triangulation (see xhandle.ts). */
    handle?: XHandleVerdict;
    /** First website a tool source declared for this contract. */
    website?: string | null;
  },
): TokenRef {
  const flags = new Set<SecurityFlag>(securityFlags);
  const handle: XHandleVerdict =
    opts?.handle ?? {
      handle: null,
      sources: [],
      tier: 'none',
      conflict: false,
      conflicting: [],
      narrativeMatched: candidate.socialsMatched,
    };
  // A handle produced by the model panel alone (or by breaking a registry
  // conflict) is evidence, not proof — it can never be presented as verified.
  const modelBackedOnly = isModelBackedOnly(handle);

  // Market-based (non-critical) flags.
  if ((candidate.liquidityUsd ?? 0) < config.minLiquidityUsd) flags.add('low_liquidity');
  if ((candidate.ageHours ?? Infinity) < config.youngPoolHours) flags.add('young_pool');

  const critical = [...flags].find((f) => CRITICAL_FLAGS.has(f as never));
  const noSecData = flags.has('no_security_data');

  // Confidence (weighted sum, clamped).
  const w = config.weights;
  let confidence = 0;
  if (handle.handle) confidence += modelBackedOnly ? w.xHandle / 2 : w.xHandle;
  // Multi-source only counts when registries back it — two models agreeing is
  // already the minimum bar for the panel to answer at all, not a bonus.
  if (!modelBackedOnly && handle.sources.length >= 2) confidence += w.xMultiSource;
  if (handle.narrativeMatched) confidence += w.xMatch;
  if (candidate.sources.length >= 2) confidence += w.crossSource;
  if (candidate.curated) confidence += w.curated;
  if (candidate.verifiedContract) confidence += w.verifiedContract;
  const healthy =
    (candidate.liquidityUsd ?? 0) >= config.minLiquidityUsd &&
    (candidate.ageHours ?? 0) >= config.youngPoolHours;
  if (healthy) confidence += w.healthyMarket;
  if (opts?.modelCaMatchesChosen) confidence += 0.05; // tool & model agree — minor bonus
  if (critical) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const base = {
    chainId: candidate.chainId,
    address: candidate.address,
    symbol: candidate.symbol,
    name: candidate.name,
    sources: candidate.sources,
    // Kept for backward compat with persisted rows + the bot formatter: it now
    // means "the model's narrative independently named the tool-resolved @".
    socialsMatched: handle.narrativeMatched,
    verifiedContract: candidate.verifiedContract ?? false,
    holders: candidate.holders ?? null,
    confidence,
    flags: [...flags],
    // TOOL-sourced identity — this is what formatters render, never the
    // model's text.
    officialX: handle.handle,
    handleSources: handle.sources,
    handleTier: handle.tier,
    website: opts?.website ?? candidate.dexWebsite ?? null,
  };

  // HARD GATE 1: registries disagree on who owns this contract → clone risk.
  if (config.cutOnHandleConflict && handle.conflict) {
    return { ...base, status: 'abstained', reason: handleConflictReason(handle) };
  }
  // HARD GATE 2: no tool source ties an official X profile to the contract.
  if (config.requireXHandle && !handle.handle) {
    return {
      ...base,
      status: 'abstained',
      reason:
        'No official X profile could be tied to this contract — not by DexScreener, ' +
        'GeckoTerminal or CoinGecko, and not by the search-model panel.',
    };
  }
  // HARD GATE 3 (opt-in): the model must also have named the same handle.
  if (config.requireNarrativeXMatch && !handle.narrativeMatched) {
    return {
      ...base,
      status: 'abstained',
      reason: 'The signal did not name the official X profile tied to this contract.',
    };
  }
  // Any critical flag → abstain (safety-first).
  if (critical) {
    return {
      ...base,
      status: 'abstained',
      reason: CRITICAL_REASON[critical] ?? 'Failed a critical security check.',
    };
  }

  // `confirmed` requires a REGISTRY-backed identity. A model-resolved or
  // contested handle caps out at low_confidence no matter how the rest scores.
  if (confidence >= config.confirmThreshold && !noSecData && !modelBackedOnly) {
    return { ...base, status: 'confirmed' };
  }
  if (confidence >= config.lowConfidenceThreshold) {
    const provenance = handle.handle ? `Official X: @${handle.handle} (${handleProvenance(handle)}). ` : '';
    const reason = noSecData
      ? `${provenance}Confirmed identity, but no security data yet — verify before buying.`
      : `${provenance}Lower confidence — verify the contract yourself before buying.`;
    return { ...base, status: 'low_confidence', reason };
  }
  return {
    ...base,
    status: 'abstained',
    reason: 'Could not confirm the contract with enough confidence.',
  };
}
