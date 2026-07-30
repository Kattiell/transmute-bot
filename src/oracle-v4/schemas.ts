/**
 * Zod schemas for every LLM stage output. Core decision fields are strict
 * (a bad verdict triggers the one repair retry in xai.ts); descriptive fields
 * are lenient with .catch() so cosmetic drift never kills a valid candidate.
 */
import { z } from 'zod';

/** Lenient string→number: "$150,000" → 150000; junk → null. */
const num = z.preprocess((v) => {
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return v;
}, z.number().nullable());

export const ScoutCandidate = z.object({
  ca: z.string(),
  chain_id: z.number().catch(0),
  ticker: z.string().nullable().catch(null),
  name: z.string().nullable().catch(null),
  claimed_fdv_usd: num.catch(null),
  claimed_mc_usd: num.catch(null),
  claimed_liq_usd: num.catch(null),
  claimed_age_hours: num.catch(null),
  pair_address: z.string().nullable().catch(null),
  official_x_handle: z.string().nullable().catch(null),
  launchpad: z.string().nullable().catch(null),
  deployer_address: z.string().nullable().catch(null),
  why_flagged: z.string().catch(''),
  source_url: z.string().catch(''),
  ca_seen_verbatim_at: z.string().catch(''),
});
export type ScoutCandidateT = z.infer<typeof ScoutCandidate> & { __shard?: string };

export const ScoutOutput = z.object({
  shard: z.string().catch('?'),
  retrieved_at: z.string().catch(''),
  candidates: z.array(ScoutCandidate).catch([]),
  // Honesty telemetry: always-zero counters mean rules 2/4 are not being applied.
  dropped_truncated_ca_count: z.number().catch(0),
  dropped_wrong_chain_count: z.number().catch(0),
});
export type ScoutOutputT = z.infer<typeof ScoutOutput>;

export const SubScores = z.object({
  asymmetry: z.number().min(0).max(10).catch(0),
  builder: z.number().min(0).max(10).catch(0),
  product: z.number().min(0).max(10).catch(0),
  distribution: z.number().min(0).max(10).catch(0),
  catalyst: z.number().min(0).max(10).catch(0),
  attention: z.number().min(0).max(10).catch(0),
  narrative: z.number().min(0).max(10).catch(0),
});
export type SubScoresT = z.infer<typeof SubScores>;

export const GateOutput = z.object({
  verdict: z.enum(['PASS', 'DISCARD']),
  discard_reason: z.string().nullable().catch(null),
  /** K01..K14 → "true" | "false" | "UNVERIFIABLE". */
  kill_switch: z.record(z.string(), z.string()).catch({}),
  ca_triangulation: z
    .object({
      project_source_url: z.string().nullable().catch(null),
      explorer_url: z.string().nullable().catch(null),
      market_url: z.string().nullable().catch(null),
    })
    .catch({ project_source_url: null, explorer_url: null, market_url: null }),
  dossier: z
    .object({
      thesis: z.string().catch(''),
      product_evidence: z.string().catch(''),
      distribution: z.string().catch(''),
      attention: z.string().catch(''),
      attention_level: z.string().catch('WEAK'),
      catalysts: z
        .array(z.object({ label: z.string().catch('SPECULATIVE'), text: z.string().catch('') }))
        .catch([]),
      invalidation: z.string().catch(''),
      unverifiable: z.array(z.string()).catch([]),
      sub_scores: SubScores,
      risk_0_10: z.number().min(0).max(10).catch(10),
    })
    .nullable()
    .catch(null),
});
export type GateOutputT = z.infer<typeof GateOutput>;

export const AttributionOutput = z.object({
  ca: z.string().catch(''),
  dev_x_handle: z.string().nullable().catch(null),
  attribution_tier: z.enum(['A', 'B', 'C', 'D']).catch('D'),
  attribution_confidence: z.number().min(0).max(1).catch(0),
  evidence: z
    .array(
      z.object({
        tier_code: z.string().catch(''),
        claim: z.string().catch(''),
        url: z.string().catch(''),
        retrieved_at: z.string().catch(''),
      }),
    )
    .catch([]),
  deployer_address: z.string().catch(''),
  funding_source: z
    .object({ type: z.string().catch('unknown'), detail: z.string().catch(''), url: z.string().catch('') })
    .catch({ type: 'unknown', detail: '', url: '' }),
  prior_deployments: z
    .array(
      z.object({
        ca: z.string().catch(''),
        chain: z.string().catch(''),
        outcome: z.string().catch('unknown'),
        url: z.string().catch(''),
      }),
    )
    .catch([]),
  impersonation_flags: z.array(z.object({ code: z.string().catch(''), detail: z.string().catch('') })).catch([]),
  competing_claimants: z.array(z.string()).catch([]),
  track_record_score: z.number().min(0).max(10).catch(0),
  track_record_basis: z.string().catch(''),
  unverifiable: z.array(z.string()).catch([]),
});
export type AttributionOutputT = z.infer<typeof AttributionOutput>;

export const RedTeamOutput = z.object({
  attacks: z
    .array(
      z.object({
        target: z.string().catch(''),
        finding: z.string().catch(''),
        severity: z.enum(['fatal', 'serious', 'minor']).catch('minor'),
        url: z.string().catch(''),
        retrieved_at: z.string().catch(''),
      }),
    )
    .catch([]),
  demoted_attribution_tier: z.enum(['A', 'B', 'C', 'D']).nullable().catch(null),
  verdict: z.enum(['KILL', 'WOUNDED', 'SURVIVES']),
  strongest_single_reason_to_pass: z.string().catch(''),
});
export type RedTeamOutputT = z.infer<typeof RedTeamOutput>;
