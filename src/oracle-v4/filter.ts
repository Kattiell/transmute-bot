/**
 * STAGE 1.5 — DETERMINISTIC FILTER (spec §STAGE 1.5). No LLM anywhere in here.
 *
 * This is the anti-hallucination spine: everything the model claimed is now
 * either confirmed by an API or discarded. The existence check alone kills
 * every invented address; the confabulation comparison turns the survivors
 * into per-shard honesty telemetry.
 */
import { isAddress, getAddress, createPublicClient, http } from 'viem';
import type { ChainContextV4 } from './chain-context';
import { K } from './constants';
import { fetchFactsV4, type FactsV4 } from './market-facts';
import type { ScoutCandidateT } from './schemas';

export interface FilterResult {
  survivors: FactsV4[];
  dropped: { ca: string; ticker?: string; reason: string }[];
  shardFlagRate: Record<string, number>;
  confabFlags: number;
}

/**
 * Contract existence: RPC eth_getCode when ROBINHOOD_RPC_URL is configured,
 * Blockscout API v2 otherwise. Returns null when neither source could answer —
 * the caller drops fail-closed (spec clause 5: missing layer = DISCARD).
 */
async function contractExists(ca: string, ctx: ChainContextV4): Promise<boolean | null> {
  if (ctx.rpc_url) {
    try {
      const client = createPublicClient({ transport: http(ctx.rpc_url, { timeout: 8000 }) });
      const code = await client.getCode({ address: getAddress(ca) });
      return Boolean(code && code !== '0x');
    } catch {
      // fall through to Blockscout
    }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://${ctx.explorer_domain}/api/v2/addresses/${ca.toLowerCase()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (res.status === 404) return false; // Blockscout has never seen this address
    if (!res.ok) return null;
    const body = (await res.json()) as { is_contract?: boolean };
    return body.is_contract === true;
  } catch {
    return null;
  }
}

export async function deterministicFilter(
  candidates: ScoutCandidateT[],
  ctx: ChainContextV4,
  exclusions: string[],
): Promise<FilterResult> {
  const dropped: { ca: string; ticker?: string; reason: string }[] = [];
  const survivors: FactsV4[] = [];
  const flags: Record<string, { n: number; flagged: number }> = {};
  let confabFlags = 0;

  // Dedupe by lowercased address, merging corroborating sources.
  const byCa = new Map<string, ScoutCandidateT[]>();
  for (const c of candidates) {
    const key = (c.ca || '').trim().toLowerCase();
    if (!key) continue;
    byCa.set(key, [...(byCa.get(key) ?? []), c]);
  }

  for (const [ca, group] of byCa) {
    const c = group[0];
    const drop = (reason: string) => dropped.push({ ca, reason });

    // 1 — format
    if (!isAddress(ca)) {
      drop('invalid_address_format');
      continue;
    }
    // 2 — wrong chain (belt and braces: Stage 1 was told, but never trust that)
    if (c.chain_id !== ctx.chain_id) {
      drop('wrong_chain');
      continue;
    }
    // 3 — existence: kills hallucinated addresses. `false` is an affirmative
    // "no contract here" from the explorer → drop. `null` means the explorer
    // could not answer (outage/rate limit) → do NOT drop on that alone; a live
    // DEX pair for this exact address on this chain (checked next) is itself
    // proof of an existing contract, and an invented CA can never have one.
    const exists = await contractExists(ca, ctx);
    if (exists === false) {
      drop('no_bytecode_at_address');
      continue;
    }

    // 4 — authoritative market data
    const facts = await fetchFactsV4(ca, ctx);
    if (!facts) {
      drop(exists === null ? 'existence_and_market_unverifiable' : 'no_live_pair_on_aggregator');
      continue;
    }
    facts.source_urls = [...new Set(group.map((g) => g.source_url).filter(Boolean))];
    const dropWithTicker = (reason: string) => dropped.push({ ca, ticker: facts.ticker, reason });

    // Exclusion list applies to the VERIFIED ticker, not the claimed one.
    if (exclusions.includes(facts.ticker.toUpperCase())) {
      dropWithTicker('excluded_ticker');
      continue;
    }

    // 5 — confabulation detection: did the model's numbers match reality?
    for (const g of group) {
      const shard = g.__shard ?? '?';
      flags[shard] ??= { n: 0, flagged: 0 };
      flags[shard].n++;
      const off = (claim: number | null, actual: number) =>
        claim != null && actual > 0 && Math.abs(claim - actual) / actual > K.CONFAB_TOLERANCE;
      if (off(g.claimed_fdv_usd, facts.fdv_usd) || off(g.claimed_liq_usd, facts.liq_usd)) {
        facts.confabulation_flag = true;
        flags[shard].flagged++;
        confabFlags++;
      }
    }

    // 6 — numeric gates, API values only. txns/makers may be null on the
    // GeckoTerminal fallback (the API does not report them) — null passes the
    // gate but stays null in the facts, so the forensic gate sees the hole.
    // Valuation band gates on the LOWER of MC and FDV (owner directive: more
    // inclusive — a token with low circulating MC but high FDV still qualifies;
    // the gate stage sees both numbers and judges the supply overhang).
    const valuation = Math.min(
      facts.mc_usd > 0 ? facts.mc_usd : Infinity,
      facts.fdv_usd > 0 ? facts.fdv_usd : Infinity,
    );
    const vl = facts.liq_usd > 0 ? facts.vol24h_usd / facts.liq_usd : Infinity;
    const gates: [boolean, string][] = [
      [valuation !== Infinity && valuation <= K.FDV_MAX, 'valuation_out_of_band'],
      [facts.liq_usd >= K.LIQ_MIN, 'liquidity_below_floor'],
      [facts.vol24h_usd >= K.VOL24H_MIN, 'volume_below_floor'],
      [vl >= K.VOL_LIQ_MIN && vl <= K.VOL_LIQ_MAX, 'vol_liq_ratio_out_of_band'],
      [facts.txns24h === null || facts.txns24h >= K.TX24H_MIN, 'too_few_txns'],
      [facts.makers24h === null || facts.makers24h >= K.MAKERS24H_MIN, 'too_few_unique_makers'],
    ];
    const failed = gates.find(([ok]) => !ok);
    if (failed) {
      dropWithTicker(failed[1]);
      continue;
    }

    survivors.push(facts);
  }

  const shardFlagRate = Object.fromEntries(
    Object.entries(flags).map(([s, v]) => [s, v.n ? v.flagged / v.n : 0]),
  );
  return { survivors, dropped, shardFlagRate, confabFlags };
}

/** Re-fetch facts older than MAX_STALENESS_MIN before synthesis (spec §STAGE 1.5 item 7). */
export async function refreshStaleFacts(facts: FactsV4, ctx: ChainContextV4): Promise<FactsV4> {
  const ageMin = (Date.now() - new Date(facts.facts_retrieved_at).getTime()) / 60_000;
  if (ageMin <= K.MAX_STALENESS_MIN) return facts;
  const fresh = await fetchFactsV4(facts.ca, ctx);
  if (!fresh) return facts; // keep the stale copy; synthesis prints its timestamp honestly
  fresh.source_urls = facts.source_urls;
  fresh.confabulation_flag = facts.confabulation_flag;
  return fresh;
}
