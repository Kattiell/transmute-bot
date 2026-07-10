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
  label: 'Base',
  emoji: '🔵',
  explorerName: 'Basescan',
  explorerTokenUrl: (address) => `https://basescan.org/token/${address}`,
  refreshTag: '',
};

export const ROBINHOOD_CHAIN: ChainInfo = {
  key: 'robinhood',
  dexChainId: 'robinhood',
  label: 'Robinhood',
  emoji: '🪶',
  explorerName: 'Blockscout',
  explorerTokenUrl: (address) => `https://robinhoodchain.blockscout.com/token/${address}`,
  refreshTag: 'rh',
};

/** Resolve the chain baked into a refresh callback tag; absent/unknown → Base. */
export function chainByRefreshTag(tag: string | undefined): ChainInfo {
  return tag === ROBINHOOD_CHAIN.refreshTag ? ROBINHOOD_CHAIN : BASE_CHAIN;
}
