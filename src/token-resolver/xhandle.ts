/**
 * Camada 4 — official X (@handle) triangulation.
 *
 * Same invariant the CA already obeys (I1), applied to the handle: the @ that
 * reaches a user NEVER comes from the discovery model's prose. It comes from a
 * tool payload, or — only to fill a gap the registries left — from a separate,
 * search-enabled model panel that is labelled as such and can never be
 * presented as verified.
 *
 * This layer exists because the paid Oracle now runs on `openai-gpt-55-pro`,
 * which has web search but NO native X/Twitter search.
 *
 * FOUR SOURCES, TWO TRUST LEVELS
 *
 *   Registries (authoritative):
 *     1. dexscreener   — `info.socials[type=twitter|x]` / `info.websites`
 *     2. geckoterminal — `/networks/base/tokens/{ca}/info` → `twitter_handle`
 *     3. coingecko     — `links.twitter_screen_name`
 *
 *   Model panel (corroborating only — see xhandle-ai.ts):
 *     4. ai:<model>    — two cheap search-enabled models that must agree
 *
 * The panel runs ONLY when the registries left a gap or disagreed, so the
 * common path costs nothing extra.
 *
 * TIERS — what the caller is allowed to claim:
 *   cross-verified  ≥2 registries agree ................ may be `confirmed`
 *   ai-corroborated 1 registry + the model panel agrees . may be `confirmed`
 *   single-source   1 registry, panel silent ........... may be `confirmed`
 *   ai-resolved     no registry; panel only ............ NEVER `confirmed`
 *   contested       registries disagreed, panel broke it  NEVER `confirmed`
 *   none            nothing found ..................... signal is CUT
 *
 * A registry conflict that the panel cannot break stays fatal: two independent
 * registries naming different owners for one contract is the strongest clone
 * signal available without X search.
 */

export type HandleTier =
  | 'cross-verified'
  | 'ai-corroborated'
  | 'single-source'
  | 'ai-resolved'
  | 'contested'
  | 'none';

export interface HandleClaim {
  /** Registry that made the claim: 'dexscreener' | 'geckoterminal' | 'coingecko'. */
  source: string;
  /** Handle as that registry reported it, or null when it had none. */
  handle: string | null;
}

export interface XHandleVerdict {
  /** The agreed handle (lowercased, no '@'), or null when none/unresolved. */
  handle: string | null;
  /** Sources backing `handle`. Model sources are prefixed `ai:`. */
  sources: string[];
  /** How much the caller may claim about this handle. */
  tier: HandleTier;
  /** True when registries reported DIFFERENT handles and it was not resolved. */
  conflict: boolean;
  /** Every distinct registry handle seen, populated on conflict. */
  conflicting: string[];
  /** Did the discovery model's narrative independently name the same handle? */
  narrativeMatched: boolean;
}

function normalize(h: string | null | undefined): string | null {
  if (!h) return null;
  const clean = h.trim().replace(/^@/, '').toLowerCase();
  // X handle grammar: 1-15 chars, alphanumeric + underscore.
  return /^[a-z0-9_]{1,15}$/.test(clean) ? clean : null;
}

function matchesNarrative(handle: string, narrativeHandles: string[]): boolean {
  return narrativeHandles.some((h) => normalize(h) === handle);
}

/**
 * Fold the REGISTRY claims into a verdict. This runs first and alone decides
 * the happy path; the model panel is only consulted afterwards, and only when
 * this returns tier 'none' / 'single-source' (see `applyAiVerdict`).
 *
 * `narrativeHandles` are the @s the discovery model wrote in its signal text.
 * They never create or override the verdict — they only set `narrativeMatched`,
 * which the decision layer treats as a confidence bonus.
 */
export function triangulateXHandle(
  claims: HandleClaim[],
  narrativeHandles: string[] = [],
): XHandleVerdict {
  const bySource = new Map<string, string>();
  for (const c of claims) {
    const h = normalize(c.handle);
    if (h) bySource.set(c.source, h);
  }

  const distinct = [...new Set(bySource.values())];

  if (distinct.length === 0) {
    return {
      handle: null,
      sources: [],
      tier: 'none',
      conflict: false,
      conflicting: [],
      narrativeMatched: false,
    };
  }

  if (distinct.length > 1) {
    return {
      handle: null,
      sources: [],
      tier: 'none',
      conflict: true,
      conflicting: distinct.sort(),
      narrativeMatched: false,
    };
  }

  const handle = distinct[0];
  const sources = [...bySource.entries()]
    .filter(([, h]) => h === handle)
    .map(([source]) => source)
    .sort();

  return {
    handle,
    sources,
    tier: sources.length >= 2 ? 'cross-verified' : 'single-source',
    conflict: false,
    conflicting: [],
    narrativeMatched: matchesNarrative(handle, narrativeHandles),
  };
}

/** Does the registry verdict warrant spending the (cheap) model panel? */
export function needsAiLeg(v: XHandleVerdict): boolean {
  return v.tier === 'none' || v.tier === 'single-source';
}

/**
 * Merge the model panel's answer into the registry verdict.
 *
 * The panel can only ever do three things — it can never overrule agreeing
 * registries, and it can never upgrade its own output to a registry's trust:
 *
 *   1. CORROBORATE a lone registry  → 'ai-corroborated'
 *   2. FILL a gap (no registry)     → 'ai-resolved'  (never `confirmed`)
 *   3. BREAK a registry conflict, but only by matching one of the conflicting
 *      handles exactly                → 'contested'  (never `confirmed`)
 *
 * Anything else leaves the registry verdict untouched.
 */
export function applyAiVerdict(
  registry: XHandleVerdict,
  ai: { handle: string | null; sources: string[] },
  narrativeHandles: string[] = [],
): XHandleVerdict {
  const aiHandle = normalize(ai.handle);
  if (!aiHandle) return registry;

  // 3. Conflict tie-break — the panel must name one of the disputed accounts.
  //    A fourth, unrelated answer proves nothing and the cut stands.
  if (registry.conflict) {
    if (!registry.conflicting.includes(aiHandle)) return registry;
    return {
      handle: aiHandle,
      sources: [...ai.sources].sort(),
      tier: 'contested',
      conflict: false,
      conflicting: registry.conflicting,
      narrativeMatched: matchesNarrative(aiHandle, narrativeHandles),
    };
  }

  // 2. Gap fill — no registry had anything.
  if (registry.tier === 'none') {
    return {
      handle: aiHandle,
      sources: [...ai.sources].sort(),
      tier: 'ai-resolved',
      conflict: false,
      conflicting: [],
      narrativeMatched: matchesNarrative(aiHandle, narrativeHandles),
    };
  }

  // 1. Corroboration — only when the panel names the SAME account as the
  //    registry. A disagreeing panel is not evidence against a registry, so it
  //    is discarded rather than treated as a conflict.
  if (registry.tier === 'single-source' && aiHandle === registry.handle) {
    return {
      ...registry,
      sources: [...registry.sources, ...ai.sources].sort(),
      tier: 'ai-corroborated',
    };
  }

  return registry;
}

/** True when the handle rests on model output alone or on a broken tie. */
export function isModelBackedOnly(v: XHandleVerdict): boolean {
  return v.tier === 'ai-resolved' || v.tier === 'contested';
}

/** Human-readable explanation for a cut caused by handle triangulation. */
export function handleConflictReason(v: XHandleVerdict): string {
  return (
    `Official X conflict — independent sources name different accounts for this ` +
    `contract (${v.conflicting.map((h) => `@${h}`).join(' vs ')}). ` +
    `Cut as a probable clone or impersonation.`
  );
}

/** Short provenance label for UI / bot cards. */
export function handleProvenance(v: XHandleVerdict): string {
  switch (v.tier) {
    case 'cross-verified':
      return `verified · ${v.sources.join(' + ')}`;
    case 'ai-corroborated':
      return `verified · ${v.sources.join(' + ')}`;
    case 'single-source':
      return `${v.sources[0] ?? 'single source'} only`;
    case 'ai-resolved':
      return `AI-resolved · no registry lists it — verify yourself`;
    case 'contested':
      return `contested · registries disagreed — verify yourself`;
    default:
      return 'not established';
  }
}
