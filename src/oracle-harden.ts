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
 * cover this chain, so the CA in the narrative is used ONLY as a lookup key:
 * DexScreener → GeckoTerminal must return a live Robinhood pair for that exact
 * address (the displayed address/data come from the tool payload — I1), and the
 * tool's ticker must match the signal's, which kills wrong-token/typo CAs.
 * With no security screening available on this chain the ceiling is
 * low_confidence — never confirmed (mirrors decide()'s no_security_data rule).
 */
export async function hardenProjectsRobinhood(projects: ParsedProject[]): Promise<HardenedProject[]> {
  const out: HardenedProject[] = [];
  for (const p of projects) {
    out.push({ ...p, resolution: await resolveRobinhoodSignal(p) });
  }
  return out;
}

async function resolveRobinhoodSignal(p: ParsedProject): Promise<TokenRef> {
  try {
    const modelCa = firstModelEvmAddress(p.fullText);
    if (!modelCa) return rhAbstained(p, 'The signal carried no contract address to verify.');
    if (!isValidEvmAddress(modelCa)) {
      return rhAbstained(p, 'Malformed contract address in the signal — not confirmed.');
    }

    const resolved = await fetchTokenSnapshot(modelCa.toLowerCase(), [ROBINHOOD_CHAIN]);
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

    // X-match: the DEX-declared X handle vs the narrative's official handles
    // (same anti-clone signal the Base resolver uses). GeckoTerminal returns no
    // socials, so bonding-curve-only tokens simply can't match.
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

    return {
      chainId: 0, // this path is keyed by ChainInfo, not a numeric id
      address: snap.address.toLowerCase(),
      symbol: snap.symbol,
      name: snap.name || undefined,
      sources: [snap.sourceName === 'GeckoTerminal' ? 'geckoterminal' : 'dexscreener'],
      socialsMatched,
      confidence: socialsMatched ? 0.7 : 0.5,
      flags,
      status: 'low_confidence',
      reason: socialsMatched
        ? 'Live Robinhood pair and official X matched, but no security screening exists for this chain yet — verify before buying.'
        : 'Live Robinhood pair verified, but the official X could not be cross-checked and this chain has no security screening — verify before buying.',
      marketUrl: snap.url,
    };
  } catch (e) {
    console.error('[oracle-harden] robinhood resolver threw — abstaining', { ticker: p.ticker, msg: (e as Error).message });
    return rhAbstained(p, 'Resolver unavailable — not confirmed.');
  }
}
