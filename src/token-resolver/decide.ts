/**
 * Camada 5 — confidence scoring + decision. Abstain beats guess (I3). A contract
 * with no official X match is CUT (owner policy). Any critical security flag, or
 * missing security data, blocks `confirmed`.
 */

import { CRITICAL_FLAGS, type ResolverConfig } from './config';
import type { Candidate, SecurityFlag, TokenRef } from './types';

const CRITICAL_REASON: Partial<Record<SecurityFlag, string>> = {
  honeypot: 'Flagged as a honeypot.',
  cannot_sell: 'Simulation says the token cannot be sold.',
  high_sell_tax: 'Sell tax above the safe threshold.',
  top_holder_concentration: 'Top holder concentration above the safe threshold.',
};

export function decide(candidate: Candidate, securityFlags: SecurityFlag[], config: ResolverConfig, opts?: { modelCaMatchesChosen?: boolean }): TokenRef {
  const flags = new Set<SecurityFlag>(securityFlags);

  // Market-based (non-critical) flags.
  if ((candidate.liquidityUsd ?? 0) < config.minLiquidityUsd) flags.add('low_liquidity');
  if ((candidate.ageHours ?? Infinity) < config.youngPoolHours) flags.add('young_pool');

  const critical = [...flags].find((f) => CRITICAL_FLAGS.has(f as never));
  const noSecData = flags.has('no_security_data');

  // Confidence (weighted sum, clamped).
  const w = config.weights;
  let confidence = 0;
  if (candidate.socialsMatched) confidence += w.xMatch;
  if (candidate.sources.length >= 2) confidence += w.crossSource;
  if (candidate.curated) confidence += w.curated;
  const healthy = (candidate.liquidityUsd ?? 0) >= config.minLiquidityUsd && (candidate.ageHours ?? 0) >= config.youngPoolHours;
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
    socialsMatched: candidate.socialsMatched,
    confidence,
    flags: [...flags],
  };

  // HARD GATE: no official X profile tied to the contract → cut it.
  if (config.requireXMatch && !candidate.socialsMatched) {
    return { ...base, status: 'abstained', reason: 'No official X profile matched the contract.' };
  }
  // Any critical flag → abstain (safety-first).
  if (critical) {
    return { ...base, status: 'abstained', reason: CRITICAL_REASON[critical] ?? 'Failed a critical security check.' };
  }

  if (confidence >= config.confirmThreshold && !noSecData) {
    return { ...base, status: 'confirmed' };
  }
  if (confidence >= config.lowConfidenceThreshold) {
    const reason = noSecData
      ? 'Confirmed identity, but no security data yet — verify before buying.'
      : 'Lower confidence — verify the contract yourself before buying.';
    return { ...base, status: 'low_confidence', reason };
  }
  return { ...base, status: 'abstained', reason: 'Could not confirm the contract with enough confidence.' };
}
