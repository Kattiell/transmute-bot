/**
 * STAGE 2 support — deterministic on-chain evidence for the forensic gate.
 *
 * The gate LLM cannot browse Blockscout or DexScreener pages: they are
 * client-side-rendered SPAs that return empty content to search tools, and a
 * fail-closed gate fed empty pages discards everything. So everything the
 * explorer API can answer is fetched HERE, in code, and injected into the
 * gate prompt as authoritative fact — the LLM judges, it never re-fetches
 * what code already proved. Every field is null-safe: null means "the API
 * did not report", which the prompt tells the model is not the same as
 * "false" or "suspicious".
 */
import type { ChainContextV4 } from './chain-context';

const FETCH_TIMEOUT_MS = 8000;

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

export interface HolderSlice {
  address: string;
  share_pct: number | null;
  is_pair: boolean;
  is_burn: boolean;
}

export interface ChainEvidence {
  holders_count: number | null;
  /** Top token holders with supply share; pair/burn addresses labeled. */
  top_holders: HolderSlice[] | null;
  /** K06 input: combined share of the top 10 holders excluding LP + burns. */
  top10_share_ex_lp_pct: number | null;
  source_verified: boolean | null;
  /** K03 input: Blockscout-reported proxy type; null = not a proxy / unknown. */
  proxy_type: string | null;
  /** K02/K04 inputs: pattern scan over the VERIFIED source (null when unverified). */
  source_flags: {
    has_public_mint: boolean;
    has_blacklist: boolean;
    has_pause: boolean;
    has_fee_setter: boolean;
    has_max_tx_or_wallet: boolean;
  } | null;
  creator_address: string | null;
  creation_tx: string | null;
  /** K05 input: who holds the LP token of the main pair. */
  lp_top_holders: HolderSlice[] | null;
  lp_burned_share_pct: number | null;
  evidence_retrieved_at: string;
}

async function bsGet(ctx: ChainContextV4, path: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${ctx.explorer_domain}/api/v2${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface RawHolderItem {
  address?: { hash?: string };
  value?: string;
}

function toSlices(
  body: Record<string, unknown> | null,
  totalSupply: number | null,
  pairAddress: string | null,
  limit: number,
): HolderSlice[] | null {
  const items = (body?.items ?? null) as RawHolderItem[] | null;
  if (!items) return null;
  const pair = pairAddress?.toLowerCase() ?? null;
  return items.slice(0, limit).map((it) => {
    const addr = (it.address?.hash ?? '').toLowerCase();
    const value = Number(it.value ?? NaN);
    const share =
      totalSupply && totalSupply > 0 && Number.isFinite(value)
        ? Math.round((value / totalSupply) * 10_000) / 100
        : null;
    return {
      address: addr,
      share_pct: share,
      is_pair: addr === pair,
      is_burn: BURN_ADDRESSES.has(addr),
    };
  });
}

export async function fetchChainEvidence(
  ca: string,
  ctx: ChainContextV4,
  pairAddress: string | null,
): Promise<ChainEvidence> {
  const addr = ca.toLowerCase();
  const [token, holders, contract, address, lpHolders] = await Promise.all([
    bsGet(ctx, `/tokens/${addr}`),
    bsGet(ctx, `/tokens/${addr}/holders`),
    bsGet(ctx, `/smart-contracts/${addr}`),
    bsGet(ctx, `/addresses/${addr}`),
    pairAddress ? bsGet(ctx, `/tokens/${pairAddress.toLowerCase()}/holders`) : Promise.resolve(null),
  ]);

  const holdersCountRaw = Number((token?.holders ?? token?.holders_count ?? NaN) as string);
  const totalSupply = Number((token?.total_supply ?? NaN) as string);
  const supply = Number.isFinite(totalSupply) && totalSupply > 0 ? totalSupply : null;

  const topHolders = toSlices(holders, supply, pairAddress, 15);
  let top10ExLp: number | null = null;
  if (topHolders) {
    const organic = topHolders.filter((h) => !h.is_pair && !h.is_burn).slice(0, 10);
    const shares = organic.map((h) => h.share_pct).filter((s): s is number => s != null);
    if (shares.length) top10ExLp = Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100;
  }

  // Blockscout returns the smart-contract record only for verified source.
  const sourcePieces = [
    contract?.source_code,
    ...(((contract?.additional_sources ?? []) as { source_code?: string }[]).map((s) => s.source_code) ?? []),
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const verified = contract ? sourcePieces.length > 0 || contract.is_verified === true : false;
  const source = sourcePieces.join('\n');
  const sourceFlags = verified && source
    ? {
        has_public_mint: /function\s+mint\s*\(/i.test(source),
        has_blacklist: /blacklist|blocklist|_isBot|banned/i.test(source),
        has_pause: /whenNotPaused|function\s+pause\s*\(/i.test(source),
        has_fee_setter: /function\s+set(Fee|Tax|Fees|Taxes)/i.test(source),
        has_max_tx_or_wallet: /maxTransaction|maxTx|maxWallet/i.test(source),
      }
    : null;

  const lpSlices = toSlices(lpHolders, null, null, 5);
  // LP-token supply is not in the holders payload; burn share is computed from
  // the raw values instead so "LP burned" is still detectable.
  let lpBurnedShare: number | null = null;
  if (lpHolders) {
    const items = (lpHolders.items ?? []) as RawHolderItem[];
    const total = items.reduce((a, it) => a + (Number(it.value ?? 0) || 0), 0);
    if (total > 0) {
      const burned = items
        .filter((it) => BURN_ADDRESSES.has((it.address?.hash ?? '').toLowerCase()))
        .reduce((a, it) => a + (Number(it.value ?? 0) || 0), 0);
      lpBurnedShare = Math.round((burned / total) * 10_000) / 100;
    }
  }

  return {
    holders_count: Number.isFinite(holdersCountRaw) ? holdersCountRaw : null,
    top_holders: topHolders,
    top10_share_ex_lp_pct: top10ExLp,
    source_verified: contract === null && address === null ? null : verified,
    proxy_type: typeof contract?.proxy_type === 'string' && contract.proxy_type ? contract.proxy_type : null,
    source_flags: sourceFlags,
    creator_address:
      typeof address?.creator_address_hash === 'string' ? address.creator_address_hash : null,
    creation_tx:
      typeof address?.creation_tx_hash === 'string'
        ? address.creation_tx_hash
        : typeof address?.creation_transaction_hash === 'string'
          ? address.creation_transaction_hash
          : null,
    lp_top_holders: lpSlices,
    lp_burned_share_pct: lpBurnedShare,
    evidence_retrieved_at: new Date().toISOString(),
  };
}
