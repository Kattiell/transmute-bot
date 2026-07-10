/**
 * Networks supported by the CA card pipeline. The flow is identical across
 * chains — only the DexScreener chain filter, the card branding and the
 * block-explorer link change. To support another network, add an entry here
 * and a trigger in api/webhook.ts.
 */

export interface ChainInfo {
  /** Stored in token_calls.chain and used in logs. */
  key: string;
  /** chainId exactly as DexScreener reports it in pair payloads. */
  dexChainId: string;
  /** Network id on GeckoTerminal — fallback source for DEXes DexScreener doesn't index. */
  geckoNetworkId: string;
  /** Display name on cards. */
  label: string;
  /** Icon rendered before the label. */
  emoji: string;
  explorerName: string;
  explorerTokenUrl: (address: string) => string;
  /**
   * Tag inside cc:rf:… refresh callback data. Base keeps '' so the buttons on
   * cards sent before multi-chain support still match.
   */
  refreshTag: string;
}

export const BASE_CHAIN: ChainInfo = {
  key: 'base',
  dexChainId: 'base',
  geckoNetworkId: 'base',
  label: 'Base',
  emoji: '🔵',
  explorerName: 'Basescan',
  explorerTokenUrl: (address) => `https://basescan.org/token/${address}`,
  refreshTag: '',
};

export const ROBINHOOD_CHAIN: ChainInfo = {
  key: 'robinhood',
  dexChainId: 'robinhood',
  geckoNetworkId: 'robinhood',
  label: 'Robinhood',
  emoji: '🪶',
  explorerName: 'Blockscout',
  explorerTokenUrl: (address) => `https://robinhoodchain.blockscout.com/token/${address}`,
  refreshTag: 'rh',
};

/** Networks the CA pipelines cover, in resolution priority order. */
export const SUPPORTED_CHAINS: ChainInfo[] = [BASE_CHAIN, ROBINHOOD_CHAIN];

/** Resolve the chain baked into a refresh callback tag; absent/unknown → Base. */
export function chainByRefreshTag(tag: string | undefined): ChainInfo {
  return tag === ROBINHOOD_CHAIN.refreshTag ? ROBINHOOD_CHAIN : BASE_CHAIN;
}

/** Resolve a token_calls.chain value; unknown/legacy rows → Base. */
export function chainByKey(key: string | null | undefined): ChainInfo {
  return key === ROBINHOOD_CHAIN.key ? ROBINHOOD_CHAIN : BASE_CHAIN;
}
