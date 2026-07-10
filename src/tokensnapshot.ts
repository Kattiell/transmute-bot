/**
 * Chain-aware token snapshot resolver shared by the CA card, /oracle, /flex
 * and the ATH cron: DexScreener first (one call, chain-priority list), then
 * GeckoTerminal per requested chain for pools DexScreener doesn't index
 * (e.g. the Virtuals bonding curve on Robinhood Chain).
 *
 * Result chain is null when the token only trades outside the requested
 * networks — callers decide whether that counts (the oracle still uses the
 * data as ground truth; the card pipeline treats it as not found).
 */

import type { ChainInfo } from './chains';
import { fetchDexScreenerSnapshot, type DexSnapshot } from './dexscreener';
import { fetchGeckoTerminalSnapshot } from './geckoterminal';

export async function fetchTokenSnapshot(
  contractAddress: string,
  chains: ChainInfo[],
): Promise<{ snapshot: DexSnapshot; chain: ChainInfo | null } | null> {
  const dex = await fetchDexScreenerSnapshot(
    contractAddress,
    chains.map((c) => c.dexChainId),
  );
  const dexChain = dex ? (chains.find((c) => c.dexChainId === dex.chain) ?? null) : null;
  if (dex && dexChain) return { snapshot: dex, chain: dexChain };

  for (const chain of chains) {
    const gt = await fetchGeckoTerminalSnapshot(
      contractAddress,
      chain.geckoNetworkId,
      chain.dexChainId,
    );
    if (gt) return { snapshot: gt, chain };
  }

  return dex ? { snapshot: dex, chain: null } : null;
}
