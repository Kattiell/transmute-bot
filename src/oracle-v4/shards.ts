/**
 * STAGE 1 shard table (spec §STAGE 1). Each shard is one API call whose
 * web_search filter carries ≤5 allowed_domains — an xAI hard cap, not a style
 * choice. Shard C exists only when Stage 0 context lists launchpads confirmed
 * live on this chain; shard E only when a trusted-scout list is configured.
 */
import type { ChainContextV4 } from './chain-context';
import type { Tool } from './llm';

export interface Shard {
  id: string;
  tools: Tool[];
}

const isoDay = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

export function buildShards(ctx: ChainContextV4, trustedHandles: string[]): Shard[] {
  const today = isoDay(0);
  const liveLaunchpadDomains = ctx.launchpads
    .filter((l) => l.live_on_chain)
    .map((l) => l.domain)
    .slice(0, 5); // hard cap

  const shards: Shard[] = [
    {
      id: 'A',
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: ['dexscreener.com', 'geckoterminal.com', 'dextools.io'] },
        },
      ],
    },
    {
      id: 'B',
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: [ctx.explorer_domain, 'docs.robinhood.com'] },
        },
      ],
    },
    ...(liveLaunchpadDomains.length
      ? [
          {
            id: 'C',
            tools: [
              { type: 'web_search' as const, filters: { allowed_domains: liveLaunchpadDomains } },
            ],
          },
        ]
      : []),
    {
      id: 'D',
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: ['github.com', 'mirror.xyz', 'farcaster.xyz', 'warpcast.com'] },
        },
      ],
    },
    ...(trustedHandles.length
      ? [
          {
            id: 'E',
            tools: [
              {
                type: 'x_search' as const,
                allowed_x_handles: trustedHandles,
                from_date: isoDay(7 * 864e5),
                to_date: today,
              },
            ],
          },
        ]
      : []),
    {
      id: 'F',
      tools: [
        {
          type: 'x_search',
          from_date: isoDay(3 * 864e5),
          to_date: today,
          enable_image_understanding: true,
        },
      ],
    },
  ];

  return shards;
}
