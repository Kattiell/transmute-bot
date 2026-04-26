/**
 * Lightweight DexScreener client used to enrich the Horus Oracle prompt.
 *
 * DexScreener public API: https://docs.dexscreener.com/api/reference
 * - Free, no auth, ~60 req/min per IP.
 * - GET /latest/dex/tokens/{address} returns every pair the token trades in,
 *   across every chain. We pick the highest-liquidity Base pair.
 *
 * If the request fails or the token isn't found we return null so callers
 * can fall back to letting Grok search itself.
 */

const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens';
const FETCH_TIMEOUT_MS = 8000;

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
  info?: {
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

export interface DexSnapshot {
  name: string;
  symbol: string;
  address: string;
  chain: string;
  url: string;
  priceUsd: number | null;
  fdvUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pairAgeDays: number | null;
  websites: string[];
  socials: { type: string; url: string }[];
}

const CA_REGEX = /^0x[a-fA-F0-9]{40}$/;

export function isValidEvmAddress(addr: string): boolean {
  return CA_REGEX.test(addr.trim());
}

export async function fetchDexScreenerSnapshot(
  contractAddress: string,
): Promise<DexSnapshot | null> {
  if (!isValidEvmAddress(contractAddress)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${DEX_API}/${contractAddress.toLowerCase()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[dexscreener] HTTP ${res.status} for ${contractAddress}`);
      return null;
    }
    const data = (await res.json()) as { pairs?: DexPair[] | null };
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return null;

    const basePairs = pairs.filter((p) => p.chainId === 'base');
    const candidates = basePairs.length > 0 ? basePairs : pairs;
    const best = candidates.reduce((acc, cur) => {
      const accLiq = acc.liquidity?.usd ?? 0;
      const curLiq = cur.liquidity?.usd ?? 0;
      return curLiq > accLiq ? cur : acc;
    });

    const ageDays = best.pairCreatedAt
      ? Math.max(0, (Date.now() - best.pairCreatedAt) / 86400_000)
      : null;

    return {
      name: best.baseToken.name,
      symbol: best.baseToken.symbol,
      address: best.baseToken.address,
      chain: best.chainId,
      url: best.url,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
      fdvUsd: best.fdv ?? null,
      mcapUsd: best.marketCap ?? null,
      liquidityUsd: best.liquidity?.usd ?? null,
      volume24hUsd: best.volume?.h24 ?? null,
      pairAgeDays: ageDays,
      websites: (best.info?.websites ?? []).map((w) => w.url).filter(Boolean),
      socials: (best.info?.socials ?? []).filter((s) => s.url),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      console.warn(`[dexscreener] timeout after ${FETCH_TIMEOUT_MS}ms`);
    } else {
      console.warn('[dexscreener] fetch failed', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'unknown';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function snapshotToPromptBlock(snap: DexSnapshot): string {
  const ageStr =
    snap.pairAgeDays === null
      ? 'unknown'
      : snap.pairAgeDays < 1
        ? `${(snap.pairAgeDays * 24).toFixed(1)}h`
        : `${snap.pairAgeDays.toFixed(1)}d`;

  const socialsLine =
    snap.socials.length === 0
      ? 'none listed'
      : snap.socials.map((s) => `${s.type}=${s.url}`).join(', ');
  const websitesLine = snap.websites.length === 0 ? 'none listed' : snap.websites.join(', ');

  return [
    `Name: ${snap.name}`,
    `Ticker: $${snap.symbol}`,
    `Contract: ${snap.address}`,
    `Chain: ${snap.chain}`,
    `DexScreener: ${snap.url}`,
    `Price USD: ${snap.priceUsd ?? 'unknown'}`,
    `FDV: ${fmtUsd(snap.fdvUsd)}`,
    `MCap: ${fmtUsd(snap.mcapUsd)}`,
    `Liquidity: ${fmtUsd(snap.liquidityUsd)}`,
    `24h Volume: ${fmtUsd(snap.volume24hUsd)}`,
    `Pair age: ${ageStr}`,
    `Websites: ${websitesLine}`,
    `Socials: ${socialsLine}`,
  ].join('\n');
}
