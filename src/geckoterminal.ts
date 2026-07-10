/**
 * GeckoTerminal fallback for pools DexScreener doesn't index — notably the
 * Virtuals bonding-curve DEX on Robinhood Chain (fresh launches like HOODBOY
 * trade there before DexScreener picks them up, if it ever does).
 *
 * Free public API, no auth, ~30 req/min per IP:
 *   GET /api/v2/networks/{network}/tokens/{address}?include=top_pools
 * Only queried after a DexScreener miss, so normal traffic stays far under
 * the cap. Returns the shared DexSnapshot shape so the card and oracle
 * pipelines don't care which source answered.
 */

import type { DexSnapshot } from './dexscreener';

const GT_API = 'https://api.geckoterminal.com/api/v2';
const FETCH_TIMEOUT_MS = 8000;

interface GtPool {
  attributes?: {
    address?: string;
    pool_created_at?: string;
    reserve_in_usd?: string;
  };
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function fetchGeckoTerminalSnapshot(
  contractAddress: string,
  geckoNetworkId: string,
  chainId: string,
): Promise<DexSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${GT_API}/networks/${geckoNetworkId}/tokens/${contractAddress.toLowerCase()}?include=top_pools`,
      { signal: controller.signal, headers: { Accept: 'application/json' } },
    );
    if (!res.ok) {
      // 404 = token unknown on this network — the expected miss, stay quiet.
      if (res.status !== 404) {
        console.warn(`[geckoterminal] HTTP ${res.status} for ${contractAddress} on ${geckoNetworkId}`);
      }
      return null;
    }
    const body = (await res.json()) as {
      data?: { attributes?: Record<string, unknown> } | null;
      included?: GtPool[] | null;
    };
    const attrs = body.data?.attributes;
    if (!attrs) return null;

    // Highest-reserve pool mirrors DexScreener's highest-liquidity pair pick.
    const pools = (body.included ?? []).filter((p) => p?.attributes);
    let best: GtPool | null = null;
    for (const pool of pools) {
      const bestReserve = num(best?.attributes?.reserve_in_usd) ?? 0;
      const poolReserve = num(pool.attributes?.reserve_in_usd) ?? 0;
      if (!best || poolReserve > bestReserve) best = pool;
    }
    // Token metadata without a single live pool → treat as no pair.
    if (!best) return null;

    const createdAt = best.attributes?.pool_created_at
      ? Date.parse(best.attributes.pool_created_at)
      : NaN;
    const volume24h = (attrs.volume_usd as { h24?: string } | undefined)?.h24;

    return {
      name: typeof attrs.name === 'string' ? attrs.name : '',
      symbol: typeof attrs.symbol === 'string' ? attrs.symbol : '',
      address: contractAddress,
      chain: chainId,
      url: `https://www.geckoterminal.com/${geckoNetworkId}/pools/${best.attributes?.address ?? ''}`,
      priceUsd: num(attrs.price_usd),
      fdvUsd: num(attrs.fdv_usd),
      mcapUsd: num(attrs.market_cap_usd),
      liquidityUsd: num(best.attributes?.reserve_in_usd),
      volume24hUsd: num(volume24h),
      pairAgeDays: Number.isFinite(createdAt)
        ? Math.max(0, (Date.now() - createdAt) / 86400_000)
        : null,
      websites: [],
      socials: [],
      sourceName: 'GeckoTerminal',
    };
  } catch (err) {
    if (controller.signal.aborted) {
      console.warn(`[geckoterminal] timeout after ${FETCH_TIMEOUT_MS}ms`);
    } else {
      console.warn('[geckoterminal] fetch failed', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
