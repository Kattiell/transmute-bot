/**
 * Bridges the LLM Oracle output to the deterministic token resolver.
 *
 * The bot's parser never extracted a CA — the formatter pulled it straight out of
 * the model's narrative text (the I1 violation). Here we resolve each signal
 * deterministically and attach a typed `resolution`; the formatter then renders
 * the TOOL-resolved address (or "couldn't confirm") instead of the model's CA.
 */

import type { ParsedProject } from './types';
import { resolveTokenFromSignal, type TokenRef } from './token-resolver';
import type { SecurityFlag } from './token-resolver';
import { firstModelEvmAddress, isValidEvmAddress } from './token-resolver/address';
import { extractXHandles, xHandleFromUrl } from './token-resolver/intent';
import { fetchTokenSnapshot } from './tokensnapshot';
import { ROBINHOOD_CHAIN } from './chains';

export interface HardenedProject extends ParsedProject {
  resolution: TokenRef;
}

/** Resolve sequentially to stay gentle on the public data/security APIs. */
export async function hardenProjects(projects: ParsedProject[]): Promise<HardenedProject[]> {
  const out: HardenedProject[] = [];
  for (const p of projects) {
    let resolution: TokenRef;
    try {
      resolution = await resolveTokenFromSignal(p);
    } catch (e) {
      // Fail-closed (I4): any resolver crash → abstain, never trust the model CA.
      console.error('[oracle-harden] resolver threw — abstaining', { ticker: p.ticker, msg: (e as Error).message });
      resolution = {
        chainId: 0, address: '', symbol: p.ticker.replace(/^\$/, ''), sources: [],
        socialsMatched: false, confidence: 0, flags: [], status: 'abstained',
        reason: 'Resolver unavailable — not confirmed.',
      };
    }
    out.push({ ...p, resolution });
  }
  return out;
}

function rhAbstained(p: ParsedProject, reason: string): TokenRef {
  return {
    chainId: 0, address: '', symbol: p.ticker.replace(/^\$/, ''), sources: [],
    socialsMatched: false, confidence: 0, flags: [], status: 'abstained', reason,
  };
}

/**
 * Robinhood Chain variant of hardenProjects. The Base resolver's stack
 * (DexScreener base-only search, BaseScan, GoPlus/honeypot.is on 8453) does not
 * cover this chain, so the CA in the narrative is used ONLY as a lookup key,
 * triangulated across TWO independent APIs before it is ever displayed:
 *
 *   1. DexScreener → GeckoTerminal must return a live Robinhood pair for that
 *      exact address, and the tool's ticker must match the signal's — kills
 *      typo'd, wrong-chain and wrong-token CAs (I1: displayed data is tool data).
 *   2. Blockscout API v2 must know the token and agree on the symbol — kills
 *      CAs that only "exist" inside a DEX aggregator payload. When the explorer
 *      is unreachable the signal survives on source 1 but stays single-source.
 *
 * Anti-clone: the DEX-profile-declared X handle is compared to the narrative's
 * official handle. A match is the only path to `confirmed`; without it the
 * signal ships as low_confidence with an explicit clone warning. Liquidity
 * below the calibrated floor abstains — a dead pool is not a signal.
 */
export async function hardenProjectsRobinhood(projects: ParsedProject[]): Promise<HardenedProject[]> {
  const out: HardenedProject[] = [];
  for (const p of projects) {
    out.push({ ...p, resolution: await resolveRobinhoodSignal(p) });
  }
  return out;
}

/** Floor mirrors oracle-v4 constants (calibrated 2026-07-30 on live pool data). */
const RH_LIQ_FLOOR_USD = Number(process.env.ORACLE_V4_LIQ_MIN) || 2_500;

/**
 * Second, independent source for the CA: the chain's own explorer.
 * Returns the explorer-reported symbol + holder count, or null when the
 * explorer could not answer (outage / indexer lag on a young chain).
 */
async function blockscoutToken(ca: string): Promise<{ symbol: string | null; holders: number | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${ca}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { symbol?: string; holders?: string; holders_count?: string };
    const holders = Number(body.holders ?? body.holders_count ?? NaN);
    return {
      symbol: typeof body.symbol === 'string' && body.symbol ? body.symbol : null,
      holders: Number.isFinite(holders) ? holders : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRobinhoodSignal(p: ParsedProject): Promise<TokenRef> {
  try {
    const modelCa = firstModelEvmAddress(p.fullText);
    if (!modelCa) return rhAbstained(p, 'The signal carried no contract address to verify.');
    if (!isValidEvmAddress(modelCa)) {
      return rhAbstained(p, 'Malformed contract address in the signal — not confirmed.');
    }

    const ca = modelCa.toLowerCase();
    const [resolved, explorer] = await Promise.all([
      fetchTokenSnapshot(ca, [ROBINHOOD_CHAIN]),
      blockscoutToken(ca),
    ]);
    if (!resolved || resolved.chain?.key !== ROBINHOOD_CHAIN.key) {
      return rhAbstained(p, 'No live Robinhood Chain pair found for this contract.');
    }
    const snap = resolved.snapshot;

    const wantSymbol = p.ticker.replace(/^\$/, '').toUpperCase();
    if ((snap.symbol || '').toUpperCase() !== wantSymbol) {
      return rhAbstained(
        p,
        `Ticker mismatch — the contract trades as $${snap.symbol || '?'}, not $${wantSymbol}. Possible wrong or cloned CA.`,
      );
    }

    // Source 2 — the explorer must AGREE on the symbol when it answers.
    // Disagreement is a hard kill; silence (null) keeps the signal single-source.
    if (explorer?.symbol && explorer.symbol.toUpperCase() !== wantSymbol) {
      return rhAbstained(
        p,
        `Explorer disagrees — Blockscout reports this contract as $${explorer.symbol}, not $${wantSymbol}. Wrong or cloned CA.`,
      );
    }
    const twoSources = explorer !== null;

    // Dead or dust pools are not signals, whatever the narrative says.
    if ((snap.liquidityUsd ?? 0) < RH_LIQ_FLOOR_USD) {
      return rhAbstained(
        p,
        `Liquidity $${Math.round(snap.liquidityUsd ?? 0).toLocaleString('en-US')} is below the $${RH_LIQ_FLOOR_USD.toLocaleString('en-US')} floor — pool too shallow to trust or trade.`,
      );
    }

    // TOOL-sourced socials from the DEX token profile: these are what gets
    // displayed, never the narrative's handles. X-match against the narrative
    // is the anti-clone signal (same as the Base resolver). GeckoTerminal
    // returns no socials, so bonding-curve-only tokens simply can't match.
    const narrativeHandles = new Set(extractXHandles(p.fullText));
    let dexHandle: string | null = null;
    for (const s of snap.socials) {
      const t = (s.type || '').toLowerCase();
      if (t === 'twitter' || t === 'x' || /twitter\.com|x\.com/i.test(s.url)) {
        const h = xHandleFromUrl(s.url);
        if (h) { dexHandle = h; break; }
      }
    }
    const socialsMatched = !!dexHandle && narrativeHandles.has(dexHandle);

    const flags: SecurityFlag[] = ['no_security_data'];
    if ((snap.liquidityUsd ?? 0) < 10_000) flags.push('low_liquidity');

    // `confirmed` requires all three legs: live pair + explorer agreement +
    // DEX-declared X matching the narrative's official X (anti-clone).
    const confirmed = twoSources && socialsMatched;
    const reason = confirmed
      ? 'CA triangulated: live pair (DexScreener), explorer agrees (Blockscout), official X matches the DEX profile. No security screening exists for this chain — still DYOR.'
      : socialsMatched
        ? 'Live pair and official X matched, but the explorer could not be reached to cross-check — verify before buying.'
        : twoSources
          ? 'CA verified on DexScreener + Blockscout, but no official X is declared on the DEX profile to rule out a same-ticker clone — verify the project source before buying.'
          : 'Live pair verified on one source only; explorer unreachable and no official X declared — verify before buying.';

    return {
      chainId: 0, // this path is keyed by ChainInfo, not a numeric id
      address: snap.address.toLowerCase(),
      symbol: snap.symbol,
      name: snap.name || undefined,
      sources: [
        snap.sourceName === 'GeckoTerminal' ? 'geckoterminal' : 'dexscreener',
        ...(twoSources ? ['blockscout'] : []),
      ],
      socialsMatched,
      holders: explorer?.holders ?? null,
      confidence: confirmed ? 0.85 : socialsMatched || twoSources ? 0.6 : 0.4,
      flags,
      status: confirmed ? 'confirmed' : 'low_confidence',
      reason,
      marketUrl: snap.url,
      officialX: dexHandle,
      website: snap.websites[0] ?? null,
    };
  } catch (e) {
    console.error('[oracle-harden] robinhood resolver threw — abstaining', { ticker: p.ticker, msg: (e as Error).message });
    return rhAbstained(p, 'Resolver unavailable — not confirmed.');
  }
}
