# 𓂀 TRANSMUTE ORACLE v4 — multi-stage alpha hunter

Replaces the v3 single-pass `/invokeRH` prompt with a staged pipeline in which
**the LLM produces candidates, REST APIs produce facts, and code compares the
two**. No LLM-authored number ever gates a decision.

```
STAGE 0   chain context        baked in code (chain-context.ts) — the model can
                               never invent an explorer URL or a launchpad
STAGE 1   scout shards A–F     temp 0.7, recall-first, ≤5 allowed_domains each
                               (xAI hard cap) — parallel fan-out
STAGE 1.5 deterministic filter NO LLM: viem/Blockscout existence check,
                               DexScreener/GeckoTerminal facts, numeric gates,
                               confabulation telemetry per shard
STAGE 2   forensic gate        temp 0.1, per candidate — CA triangulation +
                               K01–K14 kill-switch checklist
STAGE 3   dev↔X attribution    temp 0.2, per survivor — Tier A–D evidence
                               ladder + impersonation screen + guardrail
STAGE 4a  red team             temp 0.4, fresh context, bull case stripped
STAGE 4b  synthesis            temp 0.3, NO TOOLS — renders validated JSON;
                               code fallback renderer if the call fails
```

Scoring runs in code (`scoring.ts`): `ALPHA` (weighted rubric) ×
`CONFIDENCE` (attribution tier + red-team survival) = `EDGE`, the ranking key.
`RISK` is a veto, not a subtraction (≥8 can't rank #1; ≥9 excluded).
Zero picks is a valid, correct output — the pipeline never pads.

## Activation & backends

**v4 is OPT-IN: set `ORACLE_V4=on`.** By default `/invokeRH` runs the v3
single-pass `ORACLE_RH_PROMPT` ("Open-Ended Alpha Hunter") verbatim, followed
by the existing CA-hardening pass. The staged pipeline proved too strict in
its first deployment (2026-07-30: every scan returned zero because the gate
LLM was asked to browse Blockscout/DexScreener pages, which are client-side
rendered and return empty to search tools → "missing layer" → DISCARD).

The gate has since been redesigned around `chain-evidence.ts`: everything the
Blockscout API v2 can answer (holders, top-10 concentration ex-LP, verified
source + pattern flags, proxy type, creator, LP-burn share) is fetched in
code and injected as authoritative fact; L2/L3 triangulation is marked
code-satisfied, and the LLM's search task is L1 (project source published the
CA) plus the socially-verifiable K-items — with the project's own domains and
launchpads added to the search scope.

When `ORACLE_V4=on`: it runs on the bot's existing **Venice** route
(`VENICE_API_KEY`). Venice exposes only on/off search toggles — no
`allowed_domains` / `allowed_x_handles` / `from_date` filters — so shard
scoping is injected as a mandatory SOURCE SCOPE block in the prompt. That is
weaker than an API-level filter, but Stage 1.5 (code) is the hard guarantee
either way: an out-of-scope or invented CA dies at the existence/market check.
Setting `XAI_API_KEY` upgrades every stage to xAI's `/v1/responses` with true
server-side tool filters (the spec's native runtime).

| Env var | Default | Purpose |
|---|---|---|
| `VENICE_API_KEY` | (existing) | Default backend — enables v4 as-is |
| `ORACLE_V4_VENICE_MODEL` | `VENICE_MODEL` → `grok-4-3` | Venice model for the per-stage calls |
| `XAI_API_KEY` | — | Optional upgrade to hard API-level shard filters |
| `XAI_MODEL` | `grok-4.5` | xAI model when keyed |
| `XAI_BASE_URL` | `https://api.x.ai/v1` | xAI API base |
| `ORACLE_V4` | — | Set `on` to enable the staged pipeline (default: v3 single-pass prompt) |
| `ORACLE_V4_DEADLINE_MS` | `240000` | Whole-scan wall clock (webhook Lambda is 300s) |
| `ORACLE_V4_TRUSTED_HANDLES` | — | CSV, ≤20 — enables curated shard E |
| `ORACLE_V4_LAUNCHPAD_DOMAINS` | Virtuals | CSV of launchpads confirmed live on Robinhood Chain (shard C) |
| `ORACLE_V4_EXCLUDE_TICKERS` | `VEX` | Never returned as picks |
| `ROBINHOOD_RPC_URL` | — | Optional eth_getCode endpoint; Blockscout API v2 is the fallback |
| `ROBINHOOD_CHAIN_ID` | `4663` | Chain id enforced by the filter |
| `ORACLE_V4_FDV_MAX` etc. | see `constants.ts` | Numeric gates — tune from scan telemetry |

## Tuning

`LIQ_MIN` / `MAKERS24H_MIN` must match Robinhood Chain's actual depth — a
threshold calibrated for Solana returns nothing on a young L2. Defaults were
calibrated 2026-07-30 against live pool data: the genuine <$150k-FDV field on
this chain carries $2.5k–$30k liquidity, so the floors are LIQ_MIN $2.5k,
VOL24H_MIN $2k, TX24H_MIN 20, MAKERS24H_MIN 10. Re-check the distribution as
the chain deepens and raise them via env.
