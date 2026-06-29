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
// BaseScan via the Etherscan V2 multichain endpoint (chainid=8453). The
// BaseScan API key works here, and V2 is the forward-compatible host now that
// the per-chain api.basescan.org host is being sunset. Override BASESCAN_API_BASE
// to point back at api.basescan.org/api if ever needed.
const BASESCAN_API_BASE = process.env.BASESCAN_API_BASE || 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = 8453;

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

export interface BaseScanInfo {
  /** BaseScan confirms a deployed contract here — an independent existence
   *  cross-source (counts toward the resolver's crossSource signal). */
  exists: boolean;
  /** The contract's source code is publicly verified on BaseScan. */
  verified: boolean;
  /** Holder count when BaseScan exposes it (a PRO endpoint; null on free tier). */
  holders: number | null;
}

function baseScanUrl(params: Record<string, string>): string | null {
  const key = process.env.BASESCAN_API_KEY;
  if (!key) return null; // no key configured → this source simply doesn't confirm anything
  const qs = new URLSearchParams({ chainid: String(BASE_CHAIN_ID), ...params, apikey: key });
  return `${BASESCAN_API_BASE}?${qs.toString()}`;
}

/**
 * BaseScan validation for a tool-sourced (chainId,address): does BaseScan
 * recognize a deployed contract here, is its source verified, and how many
 * holders does it have.
 *
 * Used ONLY on the leading candidate (bounded cost). Fail-closed like the other
 * sources: no API key, an error, or a timeout returns "not confirmed by this
 * source" (exists/verified=false, holders=null) — never a guess.
 *
 * Implementation note: on the BaseScan free tier the `proxy` (eth_getCode) and
 * `tokenholdercount` endpoints are gated per chain, but `contract/getsourcecode`
 * works. So existence is derived from getsourcecode — a deployed contract returns
 * a non-empty ContractName (and verified ones a non-empty SourceCode); EOAs and
 * unknown addresses return empty fields. `holders` is attempted but stays null
 * unless the plan exposes it. `exists`/`verified` raise resolver confidence.
 */
export async function baseScanContractInfo(address: string): Promise<BaseScanInfo> {
  const none: BaseScanInfo = { exists: false, verified: false, holders: null };
  const addr = address.toLowerCase();

  const srcUrl = baseScanUrl({ module: 'contract', action: 'getsourcecode', address: addr });
  const holdersUrl = baseScanUrl({ module: 'token', action: 'tokenholdercount', contractaddress: addr });
  if (!srcUrl) return none; // no key → no confirmation

  const [src, hold] = await Promise.all([
    getJson(srcUrl) as Promise<
      { status?: string; result?: Array<{ SourceCode?: string; ContractName?: string }> } | null
    >,
    holdersUrl
      ? (getJson(holdersUrl) as Promise<{ status?: string; result?: string } | null>)
      : Promise.resolve(null),
  ]);

  const srcEntry = src?.status === '1' && Array.isArray(src.result) ? src.result[0] : undefined;
  const verified = !!srcEntry && typeof srcEntry.SourceCode === 'string' && srcEntry.SourceCode.trim().length > 0;
  // A non-empty ContractName means BaseScan knows a deployed contract at this
  // address (verified contracts always have one). EOAs / unknown → empty → false.
  const exists = verified || (!!srcEntry && (srcEntry.ContractName ?? '').trim().length > 0);

  let holders: number | null = null;
  if (hold?.status === '1' && typeof hold.result === 'string') {
    const n = Number(hold.result);
    holders = Number.isFinite(n) && n > 0 ? n : null;
  }

  return { exists, verified, holders };
}
