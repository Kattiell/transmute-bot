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
import { geckoTerminalHasToken, coinGeckoContract } from './sources';
import type { ParsedProject } from '../types';

export type { TokenRef, GrokIntent, SecurityFlag } from './types';
export { DEFAULT_CONFIG } from './config';
export { extractIntent } from './intent';
export { stripModelAddresses } from './address';

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
  };
}

function emitLog(intent: GrokIntent, candidates: { chainId: number; address: string; sources: string[]; socialsMatched: boolean; curated: boolean; liquidityUsd: number | null }[], ref: TokenRef) {
  const log: ResolutionLog = {
    input: { symbol: intent.symbol, handle: intent.officialXHandles[0] ?? null, chainHint: intent.chainHint, modelCa: intent.modelCa },
    candidates,
    chosen: ref.status === 'abstained' && !ref.address ? null : { address: ref.address, confidence: ref.confidence, flags: ref.flags },
    decision: ref.status,
    reason: ref.reason,
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
  const [gtExists, cg] = await Promise.all([
    geckoTerminalHasToken(top.address),
    coinGeckoContract(top.address),
  ]);
  if (gtExists && !top.sources.includes('geckoterminal')) top.sources.push('geckoterminal');
  if (cg.curated) {
    top.curated = true;
    if (!top.sources.includes('coingecko')) top.sources.push('coingecko');
    // A curated X handle that matches the narrative also satisfies the X gate.
    if (cg.xHandle && intent.officialXHandles.map((h) => h.toLowerCase()).includes(cg.xHandle)) {
      top.socialsMatched = true;
    }
  }

  const securityFlags = await validateSecurity(top.address, config);
  const ref = decide(top, securityFlags, config, { modelCaMatchesChosen: sameAddress(intent.modelCa, top.address) });

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
