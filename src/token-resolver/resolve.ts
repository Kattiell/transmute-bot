/**
 * Camada 2 — deterministic resolution. The symbol from the narrative is searched
 * against DexScreener; every candidate's address comes from the API payload. The
 * model's CA is NEVER used to find candidates (invariant I1). One resolution per
 * intent; downstream only ever sees the typed candidates (I2 — no re-resolve).
 */

import { searchDexScreener, type DexPair } from '../dexscreener';
import { BASE_CHAIN_ID, type Candidate, type GrokIntent } from './types';
import { isValidEvmAddress, toCanonicalAddress } from './address';
import { xHandleFromUrl } from './intent';

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Pull the X/Twitter handle a DEX pair declares for the contract, if any. */
function dexXHandleOf(pair: DexPair): string | null {
  for (const s of pair.info?.socials ?? []) {
    const t = (s.type || '').toLowerCase();
    if (t === 'twitter' || t === 'x' || /twitter\.com|x\.com/i.test(s.url)) {
      const h = xHandleFromUrl(s.url);
      if (h) return h;
    }
  }
  // Some pairs put the X link only under websites.
  for (const w of pair.info?.websites ?? []) {
    if (/twitter\.com|x\.com/i.test(w.url)) {
      const h = xHandleFromUrl(w.url);
      if (h) return h;
    }
  }
  return null;
}

/**
 * Resolve the intent's symbol to candidate tokens keyed by (chainId, address).
 * Exact-symbol match only (DexScreener search is fuzzy; a loose match is how
 * scam clones sneak in). Returns [] when there's no symbol or no API result
 * (fail-closed → the decision layer abstains).
 */
export async function resolveCandidates(intent: GrokIntent): Promise<Candidate[]> {
  if (!intent.symbol) return [];
  const wantSymbol = intent.symbol.toUpperCase();
  const officialHandles = new Set(intent.officialXHandles.map((h) => h.toLowerCase()));

  const pairs = await searchDexScreener(intent.symbol);

  // Collapse the many pairs-per-token into one candidate per address.
  const byAddress = new Map<string, Candidate>();
  for (const p of pairs) {
    const raw = p.baseToken?.address;
    if (!raw || !isValidEvmAddress(raw)) continue;
    if ((p.baseToken.symbol || '').toUpperCase() !== wantSymbol) continue; // exact symbol only

    let address: `0x${string}`;
    try {
      address = toCanonicalAddress(raw);
    } catch {
      continue;
    }

    const dexX = dexXHandleOf(p);
    const domains = (p.info?.websites ?? []).map((w) => domainOf(w.url)).filter((d): d is string => !!d);
    const liq = p.liquidity?.usd ?? null;
    const vol = p.volume?.h24 ?? null;
    const ageHours = p.pairCreatedAt ? Math.max(0, (Date.now() - p.pairCreatedAt) / 3_600_000) : null;
    const matched = !!dexX && officialHandles.has(dexX);

    const existing = byAddress.get(address.toLowerCase());
    if (existing) {
      // Merge: strongest signals win across this token's pools.
      existing.socialsMatched = existing.socialsMatched || matched;
      existing.dexXHandle = existing.dexXHandle ?? dexX;
      existing.liquidityUsd = Math.max(existing.liquidityUsd ?? 0, liq ?? 0) || existing.liquidityUsd;
      existing.volume24hUsd = Math.max(existing.volume24hUsd ?? 0, vol ?? 0) || existing.volume24hUsd;
      for (const d of domains) if (!existing.dexDomains.includes(d)) existing.dexDomains.push(d);
      continue;
    }

    byAddress.set(address.toLowerCase(), {
      chainId: BASE_CHAIN_ID,
      address,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      sources: ['dexscreener'],
      dexXHandle: dexX,
      dexDomains: domains,
      socialsMatched: matched,
      curated: false,
      liquidityUsd: liq,
      volume24hUsd: vol,
      ageHours,
      holders: null,
    });
  }

  return [...byAddress.values()];
}
