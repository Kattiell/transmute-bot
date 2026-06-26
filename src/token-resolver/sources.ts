/**
 * Independent cross-validation sources (Camada 2 reinforcement).
 *
 * Used ONLY on the leading candidate(s) after disambiguation, to keep calls
 * bounded. Each confirms the SAME (chainId, address) the DEX search returned —
 * raising confidence ("CA present in ≥2 independent sources"). All fail-closed:
 * an error/timeout returns "not confirmed by this source", never a guess.
 */

const FETCH_TIMEOUT_MS = 7000;

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

const GECKO_BASE = process.env.GECKOTERMINAL_API_BASE || 'https://api.geckoterminal.com/api/v2';
const COINGECKO_BASE = process.env.COINGECKO_API_BASE || 'https://api.coingecko.com/api/v3';

/** Does GeckoTerminal know this Base token? (independent existence cross-source). */
export async function geckoTerminalHasToken(address: string): Promise<boolean> {
  const json = (await getJson(`${GECKO_BASE}/networks/base/tokens/${address.toLowerCase()}`)) as
    | { data?: { attributes?: { address?: string } } }
    | null;
  return !!json?.data?.attributes?.address;
}

export interface CoinGeckoInfo {
  /** Listed on CoinGecko for Base = a curated/verified signal. */
  curated: boolean;
  /** Curated X handle CoinGecko has on file (lowercased, no '@'), or null. */
  xHandle: string | null;
}

/**
 * CoinGecko contract lookup — a curated source. Most microcaps aren't listed, so
 * a miss is normal (curated=false), never an error. When listed, it ALSO yields a
 * second, independent X handle to match against the narrative.
 */
export async function coinGeckoContract(address: string): Promise<CoinGeckoInfo> {
  const json = (await getJson(`${COINGECKO_BASE}/coins/base/contract/${address.toLowerCase()}`)) as
    | { links?: { twitter_screen_name?: string | null } }
    | null;
  if (!json) return { curated: false, xHandle: null };
  const tw = json.links?.twitter_screen_name;
  return { curated: true, xHandle: tw ? tw.replace(/^@/, '').toLowerCase() : null };
}
