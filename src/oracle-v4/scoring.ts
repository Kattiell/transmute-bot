/**
 * Scoring (spec §STAGE 4b rubric). Runs in code so it is reproducible across
 * scans — the model emits sub-scores from cited evidence; the aggregation,
 * tier multiplier, confidence and vetoes live here.
 *
 * RISK is a veto, not a subtraction. EDGE = ALPHA × CONFIDENCE is the ranking
 * key: it is what separates a Tier-D anon meme from a Tier-A builder that
 * would otherwise both print "Alpha 8".
 */
import type { SubScoresT } from './schemas';

export const WEIGHTS = {
  asymmetry: 0.25,
  builder: 0.2,
  product: 0.15,
  distribution: 0.15,
  catalyst: 0.1,
  attention: 0.1,
  narrative: 0.05,
} as const;

export type Tier = 'A' | 'B' | 'C' | 'D';

const TIER_MULT: Record<Tier, number> = { A: 1.0, B: 0.7, C: 0.0, D: 0.0 };
const TIER_CONFIDENCE: Record<Tier, number> = { A: 0.85, B: 0.65, C: 0.4, D: 0.35 };

export interface ScoreResult {
  alpha: number;
  confidence: number;
  edge: number;
  risk: number;
  eligible_for_rank_1: boolean;
  includable: boolean;
}

export function score(sub: SubScoresT, tier: Tier, risk: number, redteamSurvived: boolean): ScoreResult {
  const adjusted: Record<string, number> = { ...sub, builder: sub.builder * TIER_MULT[tier] };
  const alpha = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce(
    (acc, k) => acc + (adjusted[k] ?? 0) * WEIGHTS[k],
    0,
  );
  // Confidence falls with attribution weakness and rises with a clean red team.
  const confidence = Math.min(1, TIER_CONFIDENCE[tier] + (redteamSurvived ? 0.1 : 0));
  return {
    alpha: +alpha.toFixed(2),
    confidence: +confidence.toFixed(2),
    edge: +(alpha * confidence).toFixed(2),
    risk,
    // Risk ≥ 8 → cannot rank #1; Tier C/D never rank #1 on builder merit.
    eligible_for_rank_1: risk < 8 && (tier === 'A' || (tier === 'B' && risk <= 6)),
    // Risk ≥ 9 → cannot be included at all.
    includable: risk < 9,
  };
}
