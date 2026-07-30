/**
 * STAGE 0 — chain context (spec §STAGE 0).
 *
 * The spec's Stage 0 resolves infrastructure with an LLM once a day. In this
 * serverless runtime the same invariant — "the model can never invent an
 * explorer URL or a launchpad" — is enforced more strongly by baking the
 * first-party-verified values into code and layering env overrides on top.
 * The LLM only ever RECEIVES this context; it never produces it.
 */

export interface LaunchpadInfo {
  name: string;
  domain: string;
  live_on_chain: boolean;
  records_creator_social: boolean;
}

export interface ChainContextV4 {
  chain_id: number;
  network: string;
  /** Optional JSON-RPC endpoint for eth_getCode; Blockscout API is the fallback. */
  rpc_url: string | null;
  explorer_domain: string;
  explorerTokenUrl: (ca: string) => string;
  dexscreener_slug: string;
  geckoterminal_slug: string;
  launchpads: LaunchpadInfo[];
}

function parseLaunchpads(csv: string | undefined): LaunchpadInfo[] | null {
  if (!csv) return null;
  const out = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((domain) => ({ name: domain, domain, live_on_chain: true, records_creator_social: false }));
  return out.length ? out : null;
}

export function robinhoodChainContext(): ChainContextV4 {
  return {
    chain_id: Number(process.env.ROBINHOOD_CHAIN_ID || 4663),
    network: 'Robinhood Chain mainnet',
    rpc_url: process.env.ROBINHOOD_RPC_URL || null,
    explorer_domain: 'robinhoodchain.blockscout.com',
    explorerTokenUrl: (ca) => `https://robinhoodchain.blockscout.com/token/${ca}`,
    // Slugs match src/chains.ts (verified by the live CA-card pipeline).
    dexscreener_slug: 'robinhood',
    geckoterminal_slug: 'robinhood',
    launchpads: parseLaunchpads(process.env.ORACLE_V4_LAUNCHPAD_DOMAINS) ?? [
      // Live on Robinhood Chain per this repo's own resolver history (the
      // GeckoTerminal fallback exists to cover Virtuals bonding-curve pools).
      // Base-native launchpads (Bankr, Clanker) are deliberately absent:
      // searching a Base launchpad under a Robinhood mandate is the fastest
      // route to a wrong-chain CA (spec §0 defect 12).
      { name: 'Virtuals', domain: 'app.virtuals.io', live_on_chain: true, records_creator_social: true },
    ],
  };
}

/** JSON block injected into every stage prompt as authoritative context. */
export function chainContextJson(ctx: ChainContextV4): string {
  return JSON.stringify(
    {
      chain_id: ctx.chain_id,
      network: ctx.network,
      explorer_domain: ctx.explorer_domain,
      dexscreener_slug: ctx.dexscreener_slug,
      geckoterminal_slug: ctx.geckoterminal_slug,
      launchpads: ctx.launchpads,
    },
    null,
    2,
  );
}
