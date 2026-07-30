/**
 * TRANSMUTE ORACLE v4 — orchestrator (spec §2).
 *
 * Design invariant: the LLM produces CANDIDATES, REST APIs produce FACTS, and
 * this file compares the two. No LLM-authored number ever gates a decision.
 *
 * Stages 2/3/4a run per candidate, never batched — batching is what makes a
 * model smear facts from token A onto token B. The whole scan runs against a
 * wall-clock deadline sized for the webhook Lambda; a stage that cannot fit
 * is skipped fail-closed and reported in SCAN INTEGRITY, never guessed.
 */
import { robinhoodChainContext } from './chain-context';
import { fetchChainEvidence } from './chain-evidence';
import { K, exclusionList, trustedHandles } from './constants';
import { buildShards } from './shards';
import { deterministicFilter, refreshStaleFacts } from './filter';
import type { FactsV4 } from './market-facts';
import { attributionPrompt, gatePrompt, redteamPrompt, scoutPrompt, synthesisPrompt } from './prompts';
import {
  AttributionOutput,
  GateOutput,
  RedTeamOutput,
  ScoutOutput,
  type AttributionOutputT,
  type GateOutputT,
  type RedTeamOutputT,
  type ScoutCandidateT,
} from './schemas';
import { score, type ScoreResult, type Tier } from './scoring';
import { grokSearch, grokSynthesize } from './llm';

interface GatedCandidate {
  facts: FactsV4;
  gate: GateOutputT | null;
  attribution: AttributionOutputT | null;
  redteam: RedTeamOutputT | null;
  skipped: string[];
}

interface Pick extends GatedCandidate {
  tier: Tier;
  scores: ScoreResult;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export async function runRobinhoodScanV4(): Promise<string> {
  const ctx = robinhoodChainContext();
  const exclusions = exclusionList();
  const deadlineAt = Date.now() + K.DEADLINE_MS;
  const timeLeft = () => deadlineAt - Date.now();
  const scanStart = new Date().toISOString();
  console.log(`[oracle-v4] scan start, budget ${K.DEADLINE_MS}ms`);

  // ── STAGE 1 — parallel shard fan-out (recall-first, judgment-free) ──
  const shards = buildShards(ctx, trustedHandles());
  const scoutTimeout = Math.min(100_000, Math.max(30_000, timeLeft() * 0.35));
  const scouted = await Promise.all(
    shards.map(async (s) => {
      const r = await grokSearch({
        prompt: scoutPrompt(ctx, s.id, exclusions),
        tools: s.tools,
        schema: ScoutOutput,
        temperature: 0.7,
        timeoutMs: scoutTimeout,
        label: `scout:${s.id}`,
      });
      // Tag provenance so Stage 1.5 can compute per-shard confabulation rates.
      return r ? r.candidates.map((c): ScoutCandidateT => ({ ...c, __shard: s.id })) : [];
    }),
  );
  const rawCandidates = scouted.flat();
  console.log(`[oracle-v4] stage1: ${rawCandidates.length} raw candidates from ${shards.length} shards`);

  // ── STAGE 1.5 — deterministic filter (no LLM) ──
  const { survivors, dropped, shardFlagRate, confabFlags } = await deterministicFilter(
    rawCandidates,
    ctx,
    exclusions,
  );
  const distrusted = Object.entries(shardFlagRate)
    .filter(([, r]) => r > K.SHARD_DISTRUST_RATE)
    .map(([s]) => s);
  if (distrusted.length) console.warn(`[oracle-v4] integrity: distrust shards ${distrusted.join(', ')}`);
  console.log(`[oracle-v4] stage1.5: ${survivors.length} survivors, ${dropped.length} dropped`);

  // Bound the expensive stages: best liquidity first.
  const queue = [...survivors].sort((a, b) => b.liq_usd - a.liq_usd).slice(0, K.MAX_GATED);
  for (const extra of survivors.filter((s) => !queue.includes(s))) {
    dropped.push({ ca: extra.ca, ticker: extra.ticker, reason: 'over_gate_capacity_this_scan' });
  }

  // ── STAGES 2 → 3 → 4a — per candidate, in parallel pools, never batched ──
  const SYNTH_RESERVE_MS = 45_000;
  const stageBudget = (cap: number) => {
    const room = timeLeft() - SYNTH_RESERVE_MS;
    return room < 15_000 ? 0 : Math.min(cap, room);
  };

  const gated: GatedCandidate[] = await pool(queue, K.GATE_CONCURRENCY, async (facts) => {
    const skipped: string[] = [];

    const gateMs = stageBudget(90_000);
    if (!gateMs) return { facts, gate: null, attribution: null, redteam: null, skipped: ['gate:deadline'] };

    // Everything the explorer API can answer is fetched in code and INJECTED —
    // the gate LLM cannot browse Blockscout/DexScreener (client-rendered SPAs
    // return empty to search tools, which used to kill every candidate here).
    const evidence = await fetchChainEvidence(facts.ca, ctx, facts.pair_address);

    // L1 needs the project's own pages in scope; xAI caps allowed_domains at 5.
    const projectDomains = [...facts.websites, ...facts.socials.map((s) => s.url)]
      .map(domainOf)
      .filter((d): d is string => Boolean(d) && d !== 'x.com' && d !== 'twitter.com');
    const gateDomains = [
      ...new Set(['github.com', ...projectDomains, ...ctx.launchpads.map((l) => l.domain)]),
    ].slice(0, 5);

    const gate = await grokSearch({
      prompt: gatePrompt(facts, ctx, evidence),
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: gateDomains },
          enable_image_understanding: true,
        },
        { type: 'x_search', enable_image_understanding: true },
      ],
      schema: GateOutput,
      temperature: 0.1,
      timeoutMs: gateMs,
      label: `gate:${facts.ticker}`,
    });
    if (!gate || gate.verdict === 'DISCARD') return { facts, gate, attribution: null, redteam: null, skipped };

    const attrMs = stageBudget(80_000);
    let attribution: AttributionOutputT | null = null;
    if (attrMs) {
      attribution = await grokSearch({
        prompt: attributionPrompt(facts, JSON.stringify(gate)),
        tools: [
          { type: 'x_search', enable_image_understanding: true, enable_video_understanding: true },
          {
            type: 'web_search',
            filters: { allowed_domains: ['github.com', 'farcaster.xyz', 'warpcast.com', ctx.explorer_domain] },
          },
        ],
        schema: AttributionOutput,
        temperature: 0.2,
        timeoutMs: attrMs,
        label: `attr:${facts.ticker}`,
      });
    } else {
      skipped.push('attribution:deadline');
    }

    // STAGE 4a — fresh context: thesis, sub-scores and bull case are stripped
    // so the red team cannot anchor on the bull narrative.
    const redMs = stageBudget(70_000);
    let redteam: RedTeamOutputT | null = null;
    if (redMs) {
      const stripped = JSON.stringify(
        {
          facts,
          chain_evidence: evidence,
          kill_switch: gate.kill_switch,
          ca_triangulation: gate.ca_triangulation,
          attribution,
        },
        null,
        2,
      );
      redteam = await grokSearch({
        prompt: redteamPrompt(stripped),
        tools: [{ type: 'web_search' }, { type: 'x_search', enable_image_understanding: true }],
        schema: RedTeamOutput,
        temperature: 0.4,
        timeoutMs: redMs,
        label: `redteam:${facts.ticker}`,
      });
    } else {
      skipped.push('redteam:deadline');
    }

    return { facts, gate, attribution, redteam, skipped };
  });

  // ── Vetoes, tier demotion, scoring — all in code ──
  const rejectedAtLlm: { ca: string; ticker: string; stage: string; reason: string }[] = [];
  const picks: Pick[] = [];

  for (const g of gated) {
    const label = { ca: g.facts.ca, ticker: g.facts.ticker };
    if (!g.gate) {
      rejectedAtLlm.push({ ...label, stage: 'forensic gate', reason: 'gate_unavailable_or_timeout' });
      continue;
    }
    if (g.gate.verdict === 'DISCARD') {
      rejectedAtLlm.push({
        ...label,
        stage: 'forensic gate',
        reason: g.gate.discard_reason ?? 'kill-switch tripped',
      });
      continue;
    }
    if (g.redteam?.verdict === 'KILL' || g.redteam?.attacks.some((a) => a.severity === 'fatal')) {
      const fatal = g.redteam.attacks.find((a) => a.severity === 'fatal');
      rejectedAtLlm.push({
        ...label,
        stage: 'red team',
        reason: fatal?.finding ?? g.redteam.strongest_single_reason_to_pass,
      });
      continue;
    }
    // Impersonation flags on the claimed account escalate to K12/K13 → DISCARD.
    if (g.attribution?.impersonation_flags.length) {
      rejectedAtLlm.push({
        ...label,
        stage: 'attribution',
        reason: `impersonation flags: ${g.attribution.impersonation_flags.map((f) => f.code).join(', ')}`,
      });
      continue;
    }

    // Red-team demotion overrides Stage 3.
    let tier: Tier = g.attribution?.attribution_tier ?? 'D';
    if (g.redteam?.demoted_attribution_tier) tier = g.redteam.demoted_attribution_tier;

    const dossier = g.gate.dossier;
    if (!dossier) {
      rejectedAtLlm.push({
        ...label,
        stage: 'forensic gate',
        reason: 'gate passed without a dossier — treated as invalid output',
      });
      continue;
    }
    const scores = score(dossier.sub_scores, tier, dossier.risk_0_10, g.redteam?.verdict === 'SURVIVES');
    if (!scores.includable) {
      rejectedAtLlm.push({ ...label, stage: 'risk veto', reason: `risk ${scores.risk}/10 ≥ 9` });
      continue;
    }
    picks.push({ ...g, tier, scores });
  }

  // Rank by EDGE; risk ≥ 8 cannot hold rank #1 regardless of edge.
  picks.sort((a, b) => b.scores.edge - a.scores.edge);
  if (picks.length > 1 && !picks[0].scores.eligible_for_rank_1) {
    const idx = picks.findIndex((p) => p.scores.eligible_for_rank_1);
    if (idx > 0) picks.unshift(...picks.splice(idx, 1));
  }
  const finalPicks = picks.slice(0, K.MAX_PICKS);

  // Freshness pass before synthesis (spec §STAGE 1.5 item 7).
  for (const p of finalPicks) p.facts = await refreshStaleFacts(p.facts, ctx);

  // ── STAGE 4b — synthesis without tools; code renderer as fallback ──
  const bundle = {
    scan_utc: scanStart,
    chain_id: ctx.chain_id,
    counts: {
      scouted: rawCandidates.length,
      survived_filter: survivors.length,
      survived_gate: picks.length,
      killed_by_redteam: gated.length - picks.length,
    },
    integrity: {
      confab_flags: confabFlags,
      shard_flag_rate: shardFlagRate,
      distrusted_shards: distrusted,
      stages_skipped: gated.flatMap((g) => g.skipped.map((s) => `${g.facts.ticker}:${s}`)),
    },
    picks: finalPicks.map((p) => ({
      facts: p.facts,
      tier: p.tier,
      scores: p.scores,
      gate: p.gate,
      attribution: p.attribution,
      redteam: p.redteam,
    })),
    rejected: [
      ...dropped.map((d) => ({ ...d, stage: 'deterministic filter' })),
      ...rejectedAtLlm,
    ],
  };

  const report = await grokSynthesize(
    synthesisPrompt(JSON.stringify(bundle, null, 2)),
    0.3,
    Math.max(20_000, Math.min(90_000, timeLeft())),
  );
  return report ?? renderFallback(bundle);
}

/** Deterministic plain-text renderer used when the synthesis call fails. */
function renderFallback(bundle: {
  scan_utc: string;
  chain_id: number;
  counts: { scouted: number; survived_filter: number; survived_gate: number; killed_by_redteam: number };
  integrity: { confab_flags: number; distrusted_shards: string[]; stages_skipped: string[] };
  picks: {
    facts: FactsV4;
    tier: Tier;
    scores: ScoreResult;
    gate: GateOutputT | null;
    attribution: AttributionOutputT | null;
    redteam: RedTeamOutputT | null;
  }[];
  rejected: { ca: string; ticker?: string; stage?: string; reason: string }[];
}): string {
  const lines: string[] = [];
  const c = bundle.counts;
  lines.push(`𓂀 TRANSMUTE ORACLE — SCAN ${bundle.scan_utc} 𓂀`);
  lines.push(
    `Chain: Robinhood Chain (${bundle.chain_id}) · Candidates scanned: ${c.scouted} · Survived filter: ${c.survived_filter} · Survived gate: ${c.survived_gate}`,
  );
  lines.push('');
  if (bundle.picks.length === 0) {
    lines.push('No verified signals at this time.');
  }
  bundle.picks.forEach((p, i) => {
    const f = p.facts;
    const s = p.scores;
    lines.push(`𓂀 SIGNAL #${i + 1} — ${f.name} / $${f.ticker}`);
    lines.push(`☿ CA ${f.ca}`);
    lines.push(`☿ Pair: ${f.pair_url}`);
    lines.push(
      `☿ FDV $${Math.round(f.fdv_usd).toLocaleString('en-US')} · Liq $${Math.round(f.liq_usd).toLocaleString('en-US')} · Vol24h $${Math.round(f.vol24h_usd).toLocaleString('en-US')} — as of ${f.facts_retrieved_at}`,
    );
    lines.push(
      `☿ DEV: ${p.attribution?.dev_x_handle ?? 'UNATTRIBUTED'} · Tier ${p.tier} · Alpha ${s.alpha} · Conf ${s.confidence} · EDGE ${s.edge} · Risk ${s.risk}/10`,
    );
    if (p.gate?.dossier?.thesis) lines.push(`☿ THESIS — ${p.gate.dossier.thesis}`);
    if (p.gate?.dossier?.invalidation) lines.push(`☿ INVALIDATION — ${p.gate.dossier.invalidation}`);
    if (p.redteam?.strongest_single_reason_to_pass)
      lines.push(`☿ RED TEAM — ${p.redteam.strongest_single_reason_to_pass}`);
    lines.push('');
  });
  lines.push('𓂀 REJECTED 𓂀');
  for (const r of bundle.rejected.slice(0, 20)) {
    const t = r.ticker ? `$${r.ticker}` : r.ca;
    lines.push(`${t} — killed at ${r.stage ?? 'scan'} by ${r.reason}`);
  }
  lines.push('');
  lines.push('𓂀 SCAN INTEGRITY 𓂀');
  lines.push(
    `Confabulation flags: ${bundle.integrity.confab_flags}/${c.scouted} · Shards distrusted: ${bundle.integrity.distrusted_shards.join(', ') || 'none'} · Stages skipped: ${bundle.integrity.stages_skipped.join(', ') || 'none'}`,
  );
  lines.push('');
  lines.push('NFA. Research only. (Synthesis stage unavailable — code-rendered report.)');
  return lines.join('\n');
}
