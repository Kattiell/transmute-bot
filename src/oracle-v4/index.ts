/**
 * TRANSMUTE ORACLE v4 — public surface.
 *
 * v4 replaces the single-pass v3 prompt with a staged pipeline:
 *   1  scout shards (recall-first) → 1.5 deterministic filter (code only) →
 *   2  forensic gate → 3 dev↔X attribution → 4a red team → 4b synthesis.
 *
 * Runs through the bot's existing Venice route by default (shard scoping is
 * enforced in-prompt; Stage 1.5 is the hard guarantee), or through xAI's
 * server-side tool filters when XAI_API_KEY is set. ORACLE_V4=off forces the
 * v3 single-pass fallback (ORACLE_RH_PROMPT).
 */
export { isOracleV4Enabled } from './llm';
export { runRobinhoodScanV4 } from './orchestrator';
export { K } from './constants';
