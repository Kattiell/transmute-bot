/**
 * TRANSMUTE ORACLE v4 — stage prompts, ported from the v4.0 spec.
 *
 * Structural rule the whole file obeys: authoritative numbers (facts from
 * Stage 1.5) are INJECTED into prompts; no prompt ever asks the model to
 * produce a number that gates a decision.
 */
import type { ChainContextV4 } from './chain-context';
import { chainContextJson } from './chain-context';
import { K } from './constants';
import type { FactsV4 } from './market-facts';

/** Spec §3 — pasted verbatim into every stage. */
export const ANTI_HALLUCINATION = `
NON-NEGOTIABLE RULES
1. You have no prior knowledge of any contract address. Every address you output must
   appear byte-identical in a tool result within THIS conversation. If you cannot point
   to that tool result, output UNVERIFIED and drop the candidate.
2. Never complete, reconstruct, normalize the casing of, or "fix" a truncated address.
3. Never compute, estimate, interpolate, or round MC, FDV, liquidity, holder count, or
   age. These values are injected as authoritative. If one is absent, output NOT_PROVIDED.
   Specifically: do NOT derive FDV from price x supply.
4. Never fill a field to satisfy the output format. UNVERIFIABLE is a correct and
   preferred answer. Blank beats plausible.
5. If a required verification layer returned nothing, the candidate is DISCARDED, not
   downgraded and not "flagged for review".
6. Every factual claim carries [url, retrieved_at]. A claim without one is deleted before
   output, even if you believe it is true.
7. Never state a natural person's name. Handles and addresses only.
8. Never describe anything as safe, guaranteed, rug-proof, audited (without a linked
   audit), or a guaranteed multiple. Nothing here is financial advice.
9. Distinguish CONFIRMED (sourced fact) from INDICATIVE (convergent evidence) from
   SPECULATIVE (your inference) on every single line where the distinction applies.
10. An isolated follow, like, reply, repost, or mention is not an endorsement, a
    partnership, or a signal. Say "no meaningful endorsement found" when that is the case.
`.trim();

const SHARD_FOCUS: Record<string, string> = {
  A: 'Aggregators: new pairs, FDV band, 24h gainers, post-dip recoveries.',
  B: 'Chain-native: fresh verified contracts, deployer activity, holder growth on the explorer.',
  C: 'Launchpads live on this chain: launch feeds, creator-bound mints.',
  D: 'Builder trail: repos, casts, and posts referencing a deployment on this chain.',
  E: 'Curated X scouts: early mentions from accounts with a track record.',
  F: 'Open X discovery: raw CA mentions, launch posts, dev threads from the last 3 days.',
};

/** Spec §STAGE 1 — recall-first, judgment-free. */
export function scoutPrompt(ctx: ChainContextV4, shardId: string, exclusions: string[]): string {
  return `𓂀 STAGE 1 — SCOUT (shard ${shardId}) 𓂀

You are a wide-aperture on-chain scanner for ${ctx.network}.
CHAIN CONTEXT (authoritative, do not contradict): ${chainContextJson(ctx)}

SHARD FOCUS: ${SHARD_FOCUS[shardId] ?? 'General discovery.'}

TASK: emit every plausible token candidate you can find in this shard. Cast wide.
Do NOT verify. Do NOT score. Do NOT reject on quality. Recall is the only objective —
a later stage does the killing.

DISCOVERY BAND: include anything with FDV up to $${K.FDV_DISCOVERY.toLocaleString('en-US')} as reported by the source.
(The final <$${K.FDV_MAX.toLocaleString('en-US')} cut is applied later by code, not by you.)

Include: new deployments (<14d), tokens down >60% from ATH that are still shipping,
tokens with rising holder count, and tokens with unusually low FDV relative to a
visible product, repo, or user base.

ABSOLUTE RULES
1. You have NO prior knowledge of any contract address. Every "ca" you emit must appear
   BYTE-IDENTICAL inside a tool result in this conversation. Copy it; never retype it
   from memory, never complete a truncated address, never normalize casing.
2. If a source shows a truncated address (0xab12...9f0), you MUST resolve the full address
   from another tool result or DROP the candidate and increment dropped_truncated_ca_count.
   Never reconstruct the middle.
3. Never estimate a number. If the source did not state MC/FDV/liquidity, emit null.
   Do NOT compute FDV from price x supply.
4. "chain_id" must equal the chain_id in CHAIN CONTEXT. A candidate on any other chain is
   dropped here (increment dropped_wrong_chain_count), no exceptions, even if the ticker
   matches something interesting.
5. "source_url" is mandatory and must be the specific page the candidate was seen on —
   not a domain root, not a search page. A candidate without one is invalid output.
6. EXCLUDE tokens whose ticker is on the exclusion list: ${JSON.stringify(exclusions)}

OUTPUT: a single JSON object with this exact shape:
{
  "shard": "${shardId}",
  "retrieved_at": "ISO8601 UTC now",
  "candidates": [{
    "ca": "0x… exactly 42 chars, exactly as seen",
    "chain_id": ${ctx.chain_id},
    "ticker": "string|null",
    "name": "string|null",
    "claimed_fdv_usd": number|null,
    "claimed_mc_usd": number|null,
    "claimed_liq_usd": number|null,
    "claimed_age_hours": number|null,
    "pair_address": "string|null",
    "official_x_handle": "string|null",
    "launchpad": "string|null",
    "deployer_address": "string|null",
    "why_flagged": "one sentence",
    "source_url": "string",
    "ca_seen_verbatim_at": "the exact URL where this address string appeared"
  }],
  "dropped_truncated_ca_count": number,
  "dropped_wrong_chain_count": number
}

${ANTI_HALLUCINATION}`;
}

/** Spec §STAGE 2 — one candidate per call; facts injected, never requested. */
export function gatePrompt(facts: FactsV4, ctx: ChainContextV4): string {
  return `𓂀 STAGE 2 — FORENSIC GATE 𓂀

CHAIN CONTEXT: ${chainContextJson(ctx)}
CANDIDATE (authoritative — you may NOT alter, recompute, or contradict these values):
${JSON.stringify(facts, null, 2)}

Your job is NOT to like this token. Your job is to try to disqualify it.
Default posture: this is a scam or a dead project until evidence says otherwise.

── PART 1 — CA TRIANGULATION (all three layers required) ──
L1 PROJECT SOURCE: did the official X account, website, docs, GitHub, or launchpad record
   publish this exact address? Give the direct permalink to the post/page containing it.
L2 CHAIN: explorer page for the contract on ${ctx.explorer_domain} — deployer, deploy tx +
   timestamp, verified source yes/no, token metadata, related contracts from the same deployer.
L3 MARKET: live pair page — liquidity, recent buys AND sells by distinct makers, and
   evidence that selling actually succeeds.
If any layer is missing, ambiguous, or contradicts another → verdict DISCARD. Do not downgrade.

── PART 2 — KILL-SWITCH CHECKLIST ──
Answer each strictly "true" / "false" / "UNVERIFIABLE", each backed by [url, retrieved_at]
in the dossier. ANY "true" → DISCARD. ANY "UNVERIFIABLE" on items marked [BLOCKING] → DISCARD.

[BLOCKING] K01 honeypot: sells blocked, or transfer restricted to allowlist
[BLOCKING] K02 mint authority live, or an owner/minter role can inflate supply
[BLOCKING] K03 upgradeable proxy with a live, un-renounced admin (logic can be swapped)
[BLOCKING] K04 blacklist / pause / freeze / dynamic-fee function callable by a live admin
[BLOCKING] K05 LP neither locked nor burned, and pool age < 7 days
           K06 top-10 holders excluding LP and known burn addresses > ${Math.round(K.TOP10_EX_LP_MAX * 100)}% of supply
           K07 sniper/insider cluster (same-block or same-funder wallets) > ${Math.round(K.CLUSTER_MAX * 100)}% and still holding
           K08 buy or sell tax > ${Math.round(K.TAX_MAX * 100)}%, or asymmetric buy/sell tax
           K09 deployer or its funding wallet is linked to a prior rug or abandoned launch
           K10 volume is non-organic: same-block round-trips, 2-3 wallet ping-pong,
               unique makers wildly inconsistent with txn count
[BLOCKING] K11 CLONE / TICKER COLLISION: this ticker or name exists on another chain with
               materially larger liquidity, and the official project has NOT confirmed a
               deployment on this chain. Same-name-different-chain = clone until proven.
           K12 official X account: age < 7 days AND zero pre-launch content AND
               (handle was renamed OR follower graph is predominantly fresh accounts)
           K13 two or more distinct X accounts claim this CA, and the on-chain metadata /
               launchpad record does not resolve which is canonical
           K14 socials are fake: bought followers, engagement pods, replies that are
               templated variants of each other

── PART 3 — SURVIVOR DOSSIER (only if every kill-switch is false) ──
- thesis: 2 sentences — what is mispriced, and why is it still early
- product_evidence: what actually exists and can be opened, run, or queried — with links.
  "Website exists" is not traction. Distinguish CONFIRMED / INDICATIVE / SPECULATIVE.
- distribution: holder count trend, top-10 ex-LP, whether accumulation wallets are new or aged
- attention + attention_level: STRONG / MODERATE / WEAK / RAID-BOT. An isolated follow, like,
  reply, repost, or mention is NOT an endorsement or partnership. Say so if that is all you found.
- catalysts: each labeled CONFIRMED (dated, sourced) / PROBABLE / SPECULATIVE, with the
  repricing mechanism spelled out — who buys, with what, and why then
- invalidation: the specific observable that would end this thesis
- unverifiable: every item you could not verify, listed plainly
- sub_scores: integers 0-10 for asymmetry, builder, product, distribution, catalyst,
  attention, narrative — score ONLY from evidence cited above
- risk_0_10: overall risk (10 = uninvestable)

OUTPUT: a single JSON object:
{
  "verdict": "PASS" | "DISCARD",
  "discard_reason": "string|null",
  "kill_switch": { "K01": "true|false|UNVERIFIABLE", … "K14": "…" },
  "ca_triangulation": { "project_source_url": "…|null", "explorer_url": "…|null", "market_url": "…|null" },
  "dossier": null when DISCARD, else {
    "thesis": "…", "product_evidence": "…", "distribution": "…",
    "attention": "…", "attention_level": "STRONG|MODERATE|WEAK|RAID-BOT",
    "catalysts": [{ "label": "CONFIRMED|PROBABLE|SPECULATIVE", "text": "…" }],
    "invalidation": "…", "unverifiable": ["…"],
    "sub_scores": { "asymmetry": 0, "builder": 0, "product": 0, "distribution": 0, "catalyst": 0, "attention": 0, "narrative": 0 },
    "risk_0_10": 0
  }
}

Every claim carries [url, retrieved_at]. A claim without one must be omitted entirely,
even if you are confident it is true. UNVERIFIABLE is a correct and preferred answer.
Never fill a field to satisfy the format.

${ANTI_HALLUCINATION}`;
}

/** Spec §3.1 — the evidence ladder, injected into the attribution prompt. */
export const TIER_LADDER = `
TIER A — CONFIRMED (cryptographic, or first-party binding at mint)
A1 Deployer/owner address is a verified address on a Farcaster profile, and that profile
   self-links an X handle (verified-address records are signed — proof, not correlation)
A2 Launchpad-bound creator identity: the token was minted through a launchpad that records
   the creator's social account at creation. The launch post/cast author is the dev — pull
   it from the launchpad record or the deploy tx calldata, not from someone's claim
A3 An ENS / basename text record (com.twitter, url) set FROM the deployer address points
   to the handle
A4 The X account posts a message signed by the deployer key (verify the signature; don't
   take a screenshot's word)
A5 The official project X account published the CA itself, AND its bio/pinned links to a
   domain the project controls, AND that domain's own pages name the dev handle

TIER B — STRONG INDICATIVE (multi-source convergence; requires >=2 independent B-items)
B1 GitHub repo for the token → commit author → profile linking an X handle, AND commit
   timestamps bracket the deploy tx timestamp
B2 Deployer's other contracts trace to an earlier public project whose X account is known
B3 Funding trail: deployer funded from an address a known handle publicly posted as its own
B4 Verified contract source contains a handle in comments/NatSpec, and that account posted
   the deploy tx
B5 Project domain's public about/docs/team page names the handle; or the domain shares
   host/NS fingerprints with the dev's other public projects
B6 Author of the launch cast/post is an AGED Farcaster or X account that self-links across
   both platforms
B7 Deploy tx timestamp sits inside a window the handle publicly narrated ("deploying in
   10 min") on an account that predates the token

TIER C — CIRCUMSTANTIAL (never sufficient alone; must be printed with the label)
C1 community claims "X is the dev" · C2 handle or PFP similarity · C3 writing-style match ·
C4 mutual follows with known devs · C5 a KOL calls it "my friend's project" ·
C6 the account merely replies to the project a lot

TIER D — UNVERIFIED / ANONYMOUS BY DESIGN
The correct output when nothing above holds. Anonymous is ALLOWED — it routes the token to
the meme scoring branch with a wallet-track-record substitute, not to a rejection.
`.trim();

/** Spec §3.2 — runs before any handle is assigned. */
export const IMPERSONATION_SCREEN = `
Before you attribute ANY handle, run all seven:
I1 CONFUSABLES: check the handle for homoglyphs and lookalikes against the real project
   handle — Cyrillic а/е/о/р/с, Greek ο/ν, rn-vs-m, l-vs-I-vs-1, 0-vs-O, zero-width and
   combining characters, doubled letters, trailing underscore. Print the codepoints if
   suspicious.
I2 AGE vs PROJECT: account creation date relative to token deploy date
I3 RENAME HISTORY: has the handle or display name changed? Previous handles?
I4 FOLLOWER COMPOSITION: proportion of followers that are new, no-mutual, default-PFP,
   zero-post accounts → if dominant, classify RAID/BOT and do not treat as endorsement
I5 VERIFICATION TYPE: verified organization vs. paid subscription on a 3-week-old account
I6 DIRECTIONALITY: does the alleged dev account follow / post about the project, or does
   only the project point at them? One-way arrows are not links.
I7 COLLISION: if 2+ accounts claim this CA, none is canonical until the token's on-chain
   metadata or the launchpad creator record resolves it. Report all claimants as suspect.
`.trim();

/** Spec §3.5 — non-optional guardrail text. */
export const ATTRIBUTION_GUARDRAIL = `
GUARDRAIL (non-optional)
Use only information the subject has published themselves, or that is a matter of public
professional record they created (their own company site, their own conference talk, their
own public repo). Never assemble home location, employer-by-inference, family, financial,
or legal-name conclusions. Never publish a real name the subject has not published in
connection with this project. Anonymity chosen by a developer is a legitimate finding, not
an obstacle to overcome. A fabricated or reckless attribution makes every call this system
produces worthless. Tier D is cheap. A wrong doxx is not.
`.trim();

/** Spec §3.3 — per-survivor attribution. */
export function attributionPrompt(facts: FactsV4, gateJson: string): string {
  return `𓂀 STAGE 3 — DEV↔X ATTRIBUTION 𓂀

CANDIDATE (authoritative): ${JSON.stringify(facts, null, 2)}
GATE RESULT: ${gateJson}

GOAL: establish, to the highest tier the evidence honestly supports, which X handle
controls or created this token — and what that handle's verifiable track record is.
You are building ACCOUNTABILITY, not an identity file. See PROHIBITIONS below.

WORK THE CHAIN IN THIS ORDER (stop climbing when you hit Tier A; keep collecting for B):
1. Explorer: contract → deployer EOA → deploy tx → creation calldata.
   Was it deployed via a launchpad factory? If yes, retrieve the launchpad's creator record.
2. Deployer EOA → every other contract it deployed, with outcomes.
3. Deployer EOA → first funding tx → source (CEX withdrawal / bridge / another EOA).
   A CEX withdrawal is a dead end — say so, don't speculate past it.
4. Deployer EOA → ENS/basename reverse record → text records (com.twitter, url, github).
5. Deployer EOA → Farcaster verified-address lookup → fid → profile → linked X handle.
6. Token metadata / URI / socials fields → declared handle. Treat as a CLAIM, not proof.
7. X SEARCH — search for the literal strings: the full CA, the pair address, the deployer
   address, and the truncated forms (first 6 + last 4). Earliest post containing the CA is
   high signal. Read images: CAs and dev proofs are usually screenshots.
8. GitHub: repo → contributors → profile social links → correlate commit times to deploy time.
9. Domain: project site about page, docs, changelog, footer credits.
10. Run the IMPERSONATION SCREEN (I1-I7) on every handle you are about to report.

TIER LADDER:
${TIER_LADDER}

IMPERSONATION SCREEN:
${IMPERSONATION_SCREEN}

PROHIBITIONS — violations invalidate the entire output:
- Never state or guess a natural person's legal name, employer, city, or any personal
  detail. HANDLES AND WALLETS ONLY. If a real name appears in a source, do not carry it
  forward — cite the source and describe it as "self-published professional identity" only
  where the person published it themselves in connection with THIS project.
- Never assemble a profile from unrelated fragments across platforms to infer identity.
- Never present Tier C as Tier B. Never present an inference as a citation.
- Never fabricate a handle. null + Tier D is a correct, valuable answer.
- If the dev is anonymous by choice, that is a finding, not a failure: report Tier D and
  substitute the WALLET's track record.
- Every evidence item requires [url, retrieved_at]. Items without one are deleted.

${ATTRIBUTION_GUARDRAIL}

OUTPUT: a single JSON object:
{
  "ca": "${facts.ca}",
  "dev_x_handle": "@handle" | null,
  "attribution_tier": "A" | "B" | "C" | "D",
  "attribution_confidence": 0.0,
  "evidence": [{ "tier_code": "A2", "claim": "…", "url": "…", "retrieved_at": "ISO8601" }],
  "deployer_address": "…",
  "funding_source": { "type": "cex|bridge|eoa|unknown", "detail": "…", "url": "…" },
  "prior_deployments": [{ "ca": "…", "chain": "…", "outcome": "shipped|abandoned|rug|unknown", "url": "…" }],
  "impersonation_flags": [{ "code": "I1", "detail": "…" }],
  "competing_claimants": ["@handle"],
  "track_record_score": 0,
  "track_record_basis": "…",
  "unverifiable": ["…"]
}

${ANTI_HALLUCINATION}`;
}

/** Spec §STAGE 4a — fresh context; the bull case is stripped before this is built. */
export function redteamPrompt(strippedJson: string): string {
  return `𓂀 STAGE 4a — RED TEAM 𓂀

Below is a token and a set of claims about it. Your only objective is to DESTROY the case.
Assume it is a scam, a wash-traded shell, or an abandoned repo with a marketing budget,
and find the evidence that proves it.

${strippedJson}

Attack in this order:
1. The CA. Is this actually the canonical contract? Find any conflicting address anywhere.
2. The dev link. Attack the attribution tier directly: is the "proof" actually one-way,
   self-asserted, or an impersonation? Try to demote the tier by one level.
3. The product. Open it. Does it run? Is the repo a fork with the commit history rewritten?
   Are the "users" real? When was the last substantive commit vs. the last marketing post?
4. The volume. Reconstruct the wash pattern if one exists — name the wallets.
5. The distribution. Find the wallet cluster the bull case omitted.
6. The catalyst. Is the dated event real and sourced, or a repeat of an announcement that
   already came and went?
7. The comparable that already failed. Find the token that ran this exact playbook and died.

OUTPUT: a single JSON object:
{
  "attacks": [{ "target": "…", "finding": "…", "severity": "fatal|serious|minor", "url": "…", "retrieved_at": "ISO8601" }],
  "demoted_attribution_tier": "A|B|C|D" | null,
  "verdict": "KILL" | "WOUNDED" | "SURVIVES",
  "strongest_single_reason_to_pass": "…"
}

If you cannot find anything fatal, say SURVIVES. Do not invent an attack to look rigorous —
a fabricated attack is as damaging as a fabricated endorsement.

${ANTI_HALLUCINATION}`;
}

/** Spec §STAGE 4b — pure rendering over validated JSON; the call carries NO tools. */
export function synthesisPrompt(bundleJson: string): string {
  return `𓂀 STAGE 4b — SYNTHESIS 𓂀

You are rendering a final report from VALIDATED data. You have no tools. You may not add,
recompute, or embellish any fact, number, link, or handle — everything you print must come
from the JSON below. Scores (alpha, confidence, edge, risk) were computed in code and are
final. If a field is null or missing, print NOT_PROVIDED — never fill it.

DATA:
${bundleJson}

Render exactly this structure, in plain text (no markdown headers, no code fences):

𓂀 TRANSMUTE ORACLE — SCAN [scan_utc] 𓂀
Chain: Robinhood Chain ([chain_id]) · Candidates scanned: [counts.scouted] · Survived filter: [counts.survived_filter] · Survived gate: [counts.survived_gate] · Red-team killed: [counts.killed_by_redteam]
Data as of: [facts_retrieved_at of the newest pick] (max staleness ${K.MAX_STALENESS_MIN}m)

Rank | Project | $TICKER | FDV | Liq | Circ% | Alpha | Conf | EDGE | Risk | Dev Tier | Dev X
(one row per pick, ranked by EDGE descending)

Then for each pick:

𓂀 SIGNAL #n — [name] / $[ticker]
☿ CA [ca] · [project source url] [explorer url] [pair url]
☿ FDV / MC / Liq / Vol 24h / txns24h / makers24h / age — as of [facts_retrieved_at] UTC
☿ DEV: [@handle or UNATTRIBUTED] · Tier [A|B|C|D] ([confidence]) · evidence: [tier codes]
    ↳ deployer [address] · funded via [type] · prior: [n] deployments ([outcomes])
    ↳ impersonation flags: [none | list]
☿ THESIS — [dossier.thesis]
☿ PRODUCT / CULTURE — [dossier.product_evidence]
☿ STRUCTURE — [dossier.distribution]
☿ ATTENTION — [attention_level] + [dossier.attention]
☿ CATALYST — [each catalyst with its label]
☿ RED TEAM — strongest surviving attack, verbatim, and why it is survivable
☿ INVALIDATION — [dossier.invalidation]
☿ UNVERIFIED / UNVERIFIABLE — [list, no euphemisms]
☿ ENTRY REASON — one sharp sentence derived only from the data above

𓂀 FINAL VERDICT 𓂀
Best EDGE | Best builder (Tier A/B only) | Best meme | Best catalyst | Most asymmetric
| Highest risk | Single item most worth manual review before any size
(each chosen strictly from the picks; write "none qualified" where no pick qualifies)

𓂀 REJECTED 𓂀
[ticker or ca] — killed at [stage] by [reason] — one line each

𓂀 SCAN INTEGRITY 𓂀
Confabulation flags: [integrity.confab_flags]/[counts.scouted] · Shards distrusted: [integrity.distrusted_shards or none]
Stages skipped on timeout: [integrity.stages_skipped or none]

If picks is empty: render the header, then "No verified signals at this time." followed by
the REJECTED and SCAN INTEGRITY sections. A scan that returns zero picks with an honest
REJECTED section is a successful scan — never pad.

NFA. Research only.`;
}
