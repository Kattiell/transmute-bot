/**
 * STAGE 1.5 support — authoritative facts for one CA (spec §STAGE 1.5).
 *
 * All numbers here come from REST APIs (DexScreener full-pair payload first —
 * it carries txns; GeckoTerminal as fallback for bonding-curve pools
 * DexScreener doesn't index). Model-claimed values never enter this module.
 */
import type { ChainContextV4 } from './chain-context';
import { fetchGeckoTerminalSnapshot } from '../geckoterminal';

const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens';
const FETCH_TIMEOUT_MS = 8000;

export interface FactsV4 {
  ca: string;
  chain_id: number;
  ticker: string;
  name: string;
  fdv_usd: number;
  mc_usd: number;
  liq_usd: number;
  vol24h_usd: number;
  vol1h_usd: number | null;
  /** null = source did not report (GeckoTerminal fallback) — gate treats null as unknown, not zero. */
  txns24h: number | null;
  /** Split kept separately: sells24h > 0 across distinct makers is direct evidence sells succeed (K01). */
  buys24h: number | null;
  sells24h: number | null;
  makers24h: number | null;
  age_hours: number | null;
  pair_address: string | null;
  pair_url: string;
  circ_ratio: number | null;
  socials: { type: string; url: string }[];
  websites: string[];
  facts_retrieved_at: string;
  /** Merged from every shard that surfaced this CA — multi-shard corroboration is a signal. */
  source_urls: string[];
  confabulation_flag: boolean;
  data_source: 'dexscreener' | 'geckoterminal';
}

interface RawPair {
  chainId: string;
  url: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h1?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  makers?: { h24?: number };
  pairCreatedAt?: number;
  info?: { websites?: { url: string }[]; socials?: { type: string; url: string }[] };
}

export async function fetchFactsV4(ca: string, ctx: ChainContextV4): Promise<FactsV4 | null> {
  // DexScreener first: full pair payload including txns.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${DEX_API}/${ca.toLowerCase()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as { pairs?: RawPair[] | null };
      const onChain = (data.pairs ?? []).filter((p) => p.chainId === ctx.dexscreener_slug);
      if (onChain.length > 0) {
        const pair = onChain.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
        const buys = pair.txns?.h24?.buys;
        const sells = pair.txns?.h24?.sells;
        return {
          ca,
          chain_id: ctx.chain_id,
          ticker: pair.baseToken?.symbol ?? 'UNKNOWN',
          name: pair.baseToken?.name ?? 'UNKNOWN',
          fdv_usd: pair.fdv ?? 0,
          mc_usd: pair.marketCap ?? pair.fdv ?? 0,
          liq_usd: pair.liquidity?.usd ?? 0,
          vol24h_usd: pair.volume?.h24 ?? 0,
          vol1h_usd: pair.volume?.h1 ?? null,
          txns24h: buys != null || sells != null ? (buys ?? 0) + (sells ?? 0) : null,
          buys24h: buys ?? null,
          sells24h: sells ?? null,
          makers24h: pair.makers?.h24 ?? null,
          age_hours: pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 36e5 : null,
          pair_address: pair.pairAddress ?? null,
          pair_url: pair.url,
          circ_ratio: pair.marketCap && pair.fdv ? pair.marketCap / pair.fdv : null,
          socials: (pair.info?.socials ?? []).filter((s) => s.url),
          websites: (pair.info?.websites ?? []).map((w) => w.url).filter(Boolean),
          facts_retrieved_at: new Date().toISOString(),
          source_urls: [],
          confabulation_flag: false,
          data_source: 'dexscreener',
        };
      }
    }
  } catch {
    // fall through to GeckoTerminal
  } finally {
    clearTimeout(timer);
  }

  // GeckoTerminal fallback (covers Virtuals bonding-curve pools on this chain).
  const gt = await fetchGeckoTerminalSnapshot(ca, ctx.geckoterminal_slug, ctx.dexscreener_slug);
  if (!gt) return null;
  return {
    ca,
    chain_id: ctx.chain_id,
    ticker: gt.symbol || 'UNKNOWN',
    name: gt.name || 'UNKNOWN',
    fdv_usd: gt.fdvUsd ?? 0,
    mc_usd: gt.mcapUsd ?? gt.fdvUsd ?? 0,
    liq_usd: gt.liquidityUsd ?? 0,
    vol24h_usd: gt.volume24hUsd ?? 0,
    vol1h_usd: null,
    txns24h: null,
    buys24h: null,
    sells24h: null,
    makers24h: null,
    age_hours: gt.pairAgeDays != null ? gt.pairAgeDays * 24 : null,
    pair_address: null,
    pair_url: gt.url,
    circ_ratio: gt.mcapUsd && gt.fdvUsd ? gt.mcapUsd / gt.fdvUsd : null,
    socials: gt.socials,
    websites: gt.websites,
    facts_retrieved_at: new Date().toISOString(),
    source_urls: [],
    confabulation_flag: false,
    data_source: 'geckoterminal',
  };
}
