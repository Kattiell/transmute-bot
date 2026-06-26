/**
 * Camada 4 — security gates (EVM / Base). Two independent sources: GoPlus
 * (honeypot, tax, LP, owner, holders) and honeypot.is (buy+sell simulation).
 *
 * Fail-closed (I4): if BOTH sources are unavailable we emit `no_security_data`,
 * which the decision layer treats as "cannot confirm" — never "trust anyway".
 */

import type { ResolverConfig } from './config';
import type { SecurityFlag } from './types';

const FETCH_TIMEOUT_MS = 8000;
const GOPLUS_BASE = process.env.GOPLUS_API_BASE || 'https://api.gopluslabs.io';
const HONEYPOT_BASE = process.env.HONEYPOT_IS_API_BASE || 'https://api.honeypot.is';

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface GoPlusParsed {
  honeypot: boolean | null;
  cannotSell: boolean | null;
  sellTaxPct: number | null;
  lpLocked: boolean | null;
  ownerRenounced: boolean | null;
  topHolderPct: number | null;
}

function parseGoPlus(raw: Record<string, unknown> | undefined): GoPlusParsed | null {
  if (!raw) return null;
  const sellTax = num(raw.sell_tax);
  // top holder excluding LP / locked / burn addresses
  let topHolderPct: number | null = null;
  const holders = Array.isArray(raw.holders) ? (raw.holders as Record<string, unknown>[]) : [];
  for (const h of holders) {
    const tag = String(h.tag ?? '').toLowerCase();
    const isLocked = String(h.is_locked ?? '') === '1';
    if (isLocked || /lock|burn|dead/.test(tag)) continue;
    const pct = num(h.percent);
    if (pct !== null) topHolderPct = Math.max(topHolderPct ?? 0, pct <= 1 ? pct * 100 : pct);
  }
  return {
    honeypot: raw.is_honeypot === undefined ? null : raw.is_honeypot === '1',
    cannotSell: raw.cannot_sell_all === undefined ? null : raw.cannot_sell_all === '1',
    sellTaxPct: sellTax === null ? null : sellTax <= 1 ? sellTax * 100 : sellTax,
    lpLocked:
      raw.lp_holder_count === '0' || raw.lock_summary !== undefined
        ? true
        : raw.is_in_dex === '1'
          ? false
          : null,
    ownerRenounced:
      raw.owner_address === '0x0000000000000000000000000000000000000000' || raw.can_take_back_ownership === '0'
        ? true
        : raw.owner_address
          ? false
          : null,
    topHolderPct,
  };
}

async function fetchGoPlus(address: string): Promise<GoPlusParsed | null> {
  const json = (await getJson(`${GOPLUS_BASE}/api/v1/token_security/8453?contract_addresses=${address}`)) as
    | { result?: Record<string, Record<string, unknown>> }
    | null;
  if (!json?.result) return null;
  const key = Object.keys(json.result).find((k) => k.toLowerCase() === address.toLowerCase());
  return key ? parseGoPlus(json.result[key]) : null;
}

interface HoneypotParsed {
  honeypot: boolean | null;
  sellTaxPct: number | null;
  ok: boolean;
}

async function fetchHoneypotIs(address: string): Promise<HoneypotParsed | null> {
  const json = (await getJson(`${HONEYPOT_BASE}/v2/IsHoneypot?address=${address}&chainID=8453`)) as
    | {
        honeypotResult?: { isHoneypot?: boolean };
        simulationResult?: { sellTax?: number };
        simulationSuccess?: boolean;
      }
    | null;
  // No payload, or a payload with neither a verdict nor a simulation, is "no
  // data" (null) — NOT a clean bill of health. Lets no_security_data fire (I4).
  if (!json || (json.honeypotResult === undefined && json.simulationResult === undefined)) return null;
  return {
    honeypot: json.honeypotResult?.isHoneypot ?? null,
    sellTaxPct: num(json.simulationResult?.sellTax),
    ok: json.simulationSuccess !== false,
  };
}

/**
 * Additive anti-scam filter for the arena (and anywhere a non-blocking honeypot
 * double-check is wanted). Returns the set of addresses honeypot.is CONFIRMS as
 * honeypots. Fail-OPEN per address: unknown / error / timeout is NOT included, so
 * a honeypot.is outage never drops a legitimate candidate (the arena's GoPlus gate
 * remains the primary defense). Bounded concurrency to stay gentle on the API.
 */
export async function filterConfirmedHoneypots(addresses: string[]): Promise<Set<string>> {
  const confirmed = new Set<string>();
  const CONCURRENCY = 4;
  for (let i = 0; i < addresses.length; i += CONCURRENCY) {
    const chunk = addresses.slice(i, i + CONCURRENCY);
    const verdicts = await Promise.all(chunk.map((a) => fetchHoneypotIs(a)));
    chunk.forEach((a, j) => {
      if (verdicts[j]?.honeypot === true) confirmed.add(a.toLowerCase());
    });
  }
  return confirmed;
}

/**
 * Run both security sources and reduce to flags. `address` MUST be a tool-sourced
 * (chainId,address) — never a model string.
 */
export async function validateSecurity(address: string, config: ResolverConfig): Promise<SecurityFlag[]> {
  const [gp, hp] = await Promise.all([fetchGoPlus(address), fetchHoneypotIs(address)]);
  const flags = new Set<SecurityFlag>();

  if (!gp && !hp) {
    flags.add('no_security_data');
    return [...flags];
  }

  if (gp?.honeypot || hp?.honeypot) flags.add('honeypot');
  if (gp?.cannotSell || hp?.ok === false) flags.add('cannot_sell');

  const sellTax = Math.max(gp?.sellTaxPct ?? 0, hp?.sellTaxPct ?? 0);
  if (sellTax > config.maxSellTaxPct) flags.add('high_sell_tax');

  if (gp?.lpLocked === false) flags.add('lp_unlocked');
  if (gp?.ownerRenounced === false) flags.add('ownership_not_renounced');
  if (gp?.topHolderPct !== null && gp?.topHolderPct !== undefined && gp.topHolderPct > config.topHolderMaxPct) {
    flags.add('top_holder_concentration');
  }

  return [...flags];
}
