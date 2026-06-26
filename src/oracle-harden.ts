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
