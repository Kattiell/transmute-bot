/**
 * Camada 3 — disambiguation / ranking.
 *
 * Tie-break order (spec): (1) socialsMatched — the contract's official X matches
 * the narrative's official @handle (strongest, anti-clone); (2) curated list;
 * (3) CA confirmed in ≥2 independent sources; (4) liquidity/age — WEAK only,
 * because liquidity and volume are forgeable via wash trading.
 */

import type { Candidate, GrokIntent } from './types';

export function disambiguate(candidates: Candidate[], _intent: GrokIntent): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.socialsMatched !== b.socialsMatched) return a.socialsMatched ? -1 : 1;
    if (a.curated !== b.curated) return a.curated ? -1 : 1;
    if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
    const al = a.liquidityUsd ?? 0, bl = b.liquidityUsd ?? 0;
    if (al !== bl) return bl - al; // weak tiebreak only
    return (b.ageHours ?? 0) - (a.ageHours ?? 0);
  });
}
