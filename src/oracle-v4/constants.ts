/**
 * TRANSMUTE ORACLE v4 — tunable constants (spec §5).
 *
 * Every threshold gates on API-fetched facts, never on model-claimed values.
 * Env overrides let thresholds be tuned from scan telemetry without a deploy —
 * log the distribution across the first ~20 scans, then set from data.
 */

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const K = {
  /** Hard final cut: picks must be at or below this FDV. */
  FDV_MAX: envNum('ORACLE_V4_FDV_MAX', 500_000),
  /**
   * Ideal zone: below this FDV a pick is in the sweet spot; the
   * FDV_IDEAL–FDV_MAX range is the FLEX BAND — accepted, but the gate demands
   * proportionally stronger evidence for the same asymmetry score.
   */
  FDV_IDEAL: envNum('ORACLE_V4_FDV_IDEAL', 150_000),
  /** Stage 1 discovery band — scouts may report up to this FDV. */
  FDV_DISCOVERY: envNum('ORACLE_V4_FDV_DISCOVERY', 1_000_000),
  // Floors calibrated against live Robinhood Chain pool data (2026-07-30):
  // the real <$150k-FDV field on this young L2 carries $2.5k–$30k liquidity
  // (PIPECAT $29k, AEROYIELD $11k, NASDANQ $10.7k, TRAYCE $7.5k, KOSPI $2.7k).
  // The spec's $8k/$5k suggestions were killing nearly every genuine microcap.
  LIQ_MIN: envNum('ORACLE_V4_LIQ_MIN', 2_500),
  VOL24H_MIN: envNum('ORACLE_V4_VOL24H_MIN', 2_000),
  /** vol24h / liq outside this band = dead pool or likely wash. */
  VOL_LIQ_MIN: 0.15,
  VOL_LIQ_MAX: 25,
  TX24H_MIN: envNum('ORACLE_V4_TX24H_MIN', 20),
  /** Best cheap wash-trading filter available. */
  MAKERS24H_MIN: envNum('ORACLE_V4_MAKERS24H_MIN', 10),
  TOP10_EX_LP_MAX: 0.35,
  TOP10_EX_LP_MAX_ANON: 0.25,
  CLUSTER_MAX: 0.15,
  TAX_MAX: 0.1,
  MAX_STALENESS_MIN: 20,
  /** |claimed − actual| / actual beyond this flags the claim as confabulated. */
  CONFAB_TOLERANCE: 0.25,
  /** A shard whose confabulation rate exceeds this is distrusted wholesale. */
  SHARD_DISTRUST_RATE: 0.2,
  /** Zero picks is a valid, correct output — never pad. */
  MAX_PICKS: 6,
  /** Filter survivors that proceed to the LLM gate (cost/time bound), best liquidity first. */
  MAX_GATED: envNum('ORACLE_V4_MAX_GATED', 5),
  GATE_CONCURRENCY: envNum('ORACLE_V4_GATE_CONCURRENCY', 3),
  /**
   * Whole-scan wall-clock budget. The webhook Lambda has 300s total; 240s
   * leaves room for Telegram sends. Raise via env when running off-Lambda.
   */
  DEADLINE_MS: envNum('ORACLE_V4_DEADLINE_MS', 240_000),
};

/** Tickers never returned as picks (spec §0 defect 11 — the benchmark itself). */
export function exclusionList(): string[] {
  const csv = process.env.ORACLE_V4_EXCLUDE_TICKERS || 'VEX';
  return csv
    .split(',')
    .map((s) => s.trim().replace(/^\$/, '').toUpperCase())
    .filter(Boolean);
}

/** Curated ≤20-handle trusted scout list for shard E (x_search allowed_x_handles cap). */
export function trustedHandles(): string[] {
  const csv = process.env.ORACLE_V4_TRUSTED_HANDLES || '';
  return csv
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean)
    .slice(0, 20);
}
