/**
 * Token resolver — public facade.
 *
 * resolveTokenForIntent: intent → ONE deterministic resolution → TokenRef
 * (confirmed | low_confidence | abstained). After this, only TokenRef travels;
 * nothing re-resolves by symbol (I2). Every contract address originates from a
 * tool payload (I1); the model's CA is at most a cross-check (I3 abstain on doubt).
 */

import { DEFAULT_CONFIG, type ResolverConfig } from './config';
import type { GrokIntent, ResolutionLog, TokenRef } from './types';
import { resolveCandidates } from './resolve';
import { disambiguate } from './disambiguate';
import { validateSecurity } from './security';
import { decide } from './decide';
import { sameAddress } from './address';
import { extractIntent } from './intent';
import { coinGeckoContract, baseScanContractInfo, geckoTerminalTokenInfo } from './sources';
import { applyAiVerdict, needsAiLeg, triangulateXHandle } from './xhandle';
import { resolveXHandleWithAI } from './xhandle-ai';
import type { ParsedProject } from '../types';

export type { TokenRef, GrokIntent, SecurityFlag } from './types';
export type { XHandleVerdict, HandleTier } from './xhandle';
export { DEFAULT_CONFIG } from './config';
export { extractIntent } from './intent';
export { stripModelAddresses } from './address';
export { triangulateXHandle, applyAiVerdict, handleProvenance } from './xhandle';
export { resolveXHandleWithAI } from './xhandle-ai';

function abstained(reason: string, intent: GrokIntent): TokenRef {
  return {
    chainId: intent.chainHint ?? 0,
    address: '',
    symbol: intent.symbol ?? '',
    sources: [],
    socialsMatched: false,
    confidence: 0,
    flags: [],
    status: 'abstained',
    reason,
    officialX: null,
    handleSources: [],
    handleTier: 'none',
    website: null,
  };
}

function emitLog(intent: GrokIntent, candidates: { chainId: number; address: string; sources: string[]; socialsMatched: boolean; curated: boolean; liquidityUsd: number | null }[], ref: TokenRef) {
  const log: ResolutionLog = {
    input: { symbol: intent.symbol, handle: intent.officialXHandles[0] ?? null, chainHint: intent.chainHint, modelCa: intent.modelCa },
    candidates,
    chosen: ref.status === 'abstained' && !ref.address ? null : { address: ref.address, confidence: ref.confidence, flags: ref.flags },
    decision: ref.status,
    reason: ref.reason,
    officialX: ref.officialX ?? null,
    handleSources: ref.handleSources ?? [],
    handleTier: ref.handleTier ?? 'none',
  };
  console.log('[token-resolver]', JSON.stringify(log));
}

/** Core resolution for a typed intent. */
export async function resolveTokenForIntent(intent: GrokIntent, config: ResolverConfig = DEFAULT_CONFIG): Promise<TokenRef> {
  if (!intent.symbol) {
    const ref = abstained('No symbol identified by the model.', intent);
    emitLog(intent, [], ref);
    return ref;
  }

  const candidates = await resolveCandidates(intent);
  if (candidates.length === 0) {
    const ref = abstained('No tradable contract found for this symbol.', intent);
    emitLog(intent, [], ref);
    return ref;
  }

  const ranked = disambiguate(candidates, intent);
  const top = ranked[0];

  // Enrich the leading candidate with independent cross-sources (bounded cost).
  // BaseScan validates existence + verified source + holders (the system-wide
  // "DexScreener → BaseScan" CA discipline); GeckoTerminal/CoinGecko add further
  // independent confirmation of the SAME (chainId, address) AND a second/third
  // independent reading of the official X handle.
  const [gt, cg, bs] = await Promise.all([
    geckoTerminalTokenInfo(top.address),
    coinGeckoContract(top.address),
    baseScanContractInfo(top.address),
  ]);
  if (gt.exists && !top.sources.includes('geckoterminal')) top.sources.push('geckoterminal');
  if (bs.exists && !top.sources.includes('basescan')) top.sources.push('basescan');
  if (bs.verified) top.verifiedContract = true;
  if (bs.holders !== null) top.holders = bs.holders;
  if (cg.curated) {
    top.curated = true;
    if (!top.sources.includes('coingecko')) top.sources.push('coingecko');
  }

  // Triangulate the official @ across the three registries. The discovery
  // model's narrative handles are passed only as a cross-check (they set
  // `narrativeMatched`, never the handle itself) — invariant I1 for socials.
  let handle = triangulateXHandle(
    [
      { source: 'dexscreener', handle: top.dexXHandle },
      { source: 'geckoterminal', handle: gt.xHandle },
      { source: 'coingecko', handle: cg.xHandle },
    ],
    intent.officialXHandles,
  );

  // Fourth leg — only when the registries left a gap or disagreed, so the
  // common path pays nothing. Two cheap search-enabled models must agree; one
  // of them still has native X search, which the discovery model lacks. Their
  // answer is CORROBORATION, never proof: `applyAiVerdict` tags the result
  // `ai-resolved` / `contested`, and `decide` refuses to mark those confirmed.
  if (config.aiHandleFallback && needsAiLeg(handle)) {
    const ai = await resolveXHandleWithAI({
      address: top.address,
      symbol: top.symbol,
      name: top.name ?? intent.name,
      chainLabel: 'Base',
      marketUrl: `https://dexscreener.com/base/${top.address.toLowerCase()}`,
      website: top.dexWebsite ?? gt.website ?? null,
    });
    handle = applyAiVerdict(handle, ai, intent.officialXHandles);
  }

  const securityFlags = await validateSecurity(top.address, config);
  const ref = decide(top, securityFlags, config, {
    modelCaMatchesChosen: sameAddress(intent.modelCa, top.address),
    handle,
    website: top.dexWebsite ?? gt.website ?? null,
  });

  emitLog(
    intent,
    ranked.map((c) => ({ chainId: c.chainId, address: c.address, sources: c.sources, socialsMatched: c.socialsMatched, curated: c.curated, liquidityUsd: c.liquidityUsd })),
    ref,
  );
  return ref;
}

/** Facade for the Oracle path: parsed signal → hardened TokenRef. */
export async function resolveTokenFromSignal(p: ParsedProject, config: ResolverConfig = DEFAULT_CONFIG): Promise<TokenRef> {
  return resolveTokenForIntent(extractIntent(p), config);
}
