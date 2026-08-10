# token-resolver

Hardens the "right token, wrong/scam address" class of bug out of the Oracle
pipeline. A contract address (CA) is identity **only** as `(chainId, address)`,
and may enter the system **only** from a deterministic tool/API payload — never
from LLM-generated text.

## Invariants (hard rules, enforced in code)

- **I1 — CA never from the LLM.** The model emits *intent* (symbol, official X
  @handle, links). The canonical CA always comes from a tool (DexScreener search).
  The model's CA is at most a cross-check (`stripModelAddresses` scrubs it from
  free text; `firstModelEvmAddress` keeps it only to compare).
- **I2 — Resolve once, propagate the typed `TokenRef`.** No function downstream
  accepts a bare `symbol` to identify a token. One resolution per intent.
- **I3 — Abstain > guess.** Low confidence / ambiguity / divergence → `abstained`.
- **I4 — Fail closed.** Data/security API down, timeout, rate-limit → not confirmed.

## Owner policy

**A contract with no official X (Twitter) profile tied to it is CUT** — never
`confirmed`.

**How that gate is enforced changed with `openai-gpt-55-pro`.** The old gate
compared the DEX-declared social against the @handle the MODEL wrote in its
narrative; that only worked because Grok had native X search to look the
handle up. GPT-5.5 has web search but **no X search**, so a
narrative-dependent gate would abstain on nearly everything.

The gate is now **tool-vs-tool** (`xhandle.ts`). The official @ is triangulated
across three independent registries:

| # | Source | Field | Trust |
|---|---|---|---|
| 1 | DexScreener | `info.socials[type=twitter\|x]`, falling back to `info.websites` | registry |
| 2 | GeckoTerminal | `/networks/base/tokens/{ca}/info` → `twitter_handle` | registry |
| 3 | CoinGecko | `links.twitter_screen_name` | registry |
| 4 | Search-model panel (`xhandle-ai.ts`) | two cheap models with live search that must agree | corroborating |

Leg 4 exists because registries are authoritative but often **empty** — a token
profile only carries socials once someone claims it, which for a days-old
microcap usually has not happened. Cutting those signals meant losing exactly
the tokens the Oracle exists to find. The panel runs **only** on the gap or
conflict path, so the happy path costs nothing, and `grok-4-20` sits in the
default pair because it is the only family here that still has **native X
search** — the capability gpt-5.5-pro lacks.

Resulting tiers (`TokenRef.handleTier`):

| Tier | Meaning | May be `confirmed`? |
|---|---|---|
| `cross-verified` | ≥2 registries agree | yes |
| `ai-corroborated` | 1 registry + the panel agrees | yes |
| `single-source` | 1 registry, panel silent | yes |
| `ai-resolved` | no registry; panel only | **never** |
| `contested` | registries disagreed, panel broke the tie | **never** |
| `none` | nothing found → signal is **CUT** | — |

Hard rules the panel can never bend:

- it **cannot overrule** agreeing registries — a disagreeing panel is discarded,
  not treated as a conflict
- it **cannot break a conflict** except by naming one of the disputed handles
- an unbroken registry conflict stays **fatal** (`cutOnHandleConflict`)
- nothing at all from any leg → **CUT** (`requireXHandle`)
- a panel-only handle never reaches `confirmed`, however well the rest scores

The discovery model's narrative handle never creates or overrides the verdict —
it only sets `socialsMatched`, worth a confidence bonus. The legacy behaviour is
still available via `requireNarrativeXMatch: true` (do not enable it under
GPT-5.5).

## Pipeline (`resolveTokenForIntent`)

1. **Intent** (`intent.ts`) — derived from the already-parsed Oracle signal (no
   extra LLM call). Mines official X handles + links; quarantines the model CA.
2. **Resolve** (`resolve.ts`) — `searchDexScreener(symbol)` → candidates keyed by
   `(chainId, address)`, exact-symbol only. Every address is from the API.
3. **Disambiguate** (`disambiguate.ts`) — X-match → curated → ≥2 sources →
   liquidity/age (liquidity is a **weak** tiebreak — wash-tradeable).
4. **Security** (`security.ts`) — GoPlus + honeypot.is (two independent sources).
   Both down → `no_security_data` (blocks `confirmed`).
5. **Decide** (`decide.ts`) — weighted confidence + thresholds → `TokenRef`.

Scope: **EVM / Base (8453)**. Solana/RugCheck/Birdeye are intentionally out.

## Configurable thresholds (`config.ts`)

| Knob | Default | Meaning |
|---|---|---|
| `requireXHandle` | `true` | Hard gate: no TOOL source declares an official X → `abstained` (owner policy). |
| `cutOnHandleConflict` | `true` | Hard gate: two registries name different @s → `abstained` (clone). |
| `requireNarrativeXMatch` | `false` | Legacy gate: also require the model's narrative to name the same @. Leave off under GPT-5.5 (no X search). |
| `aiHandleFallback` | `true` | Consult the search-model panel on the gap/conflict path. Off → those signals are cut, as before. Env: `RESOLVER_AI_HANDLE=off`, `RESOLVER_AI_HANDLE_MODELS`, `RESOLVER_AI_HANDLE_TIMEOUT_MS`. |
| `confirmThreshold` | `0.80` | `confidence ≥` this **and** zero critical flags **and** a tool-sourced X **and** security data → `confirmed`. |
| `lowConfidenceThreshold` | `0.50` | `≥` this → `low_confidence` (CA returned **with a warning**); below → `abstained`. |
| `weights.xHandle` | `0.35` | ≥1 tool source declares an official X for the contract. |
| `weights.xMultiSource` | `0.25` | ≥2 tool sources agree on the SAME handle (strongest). |
| `weights.xMatch` | `0.15` | The model's narrative independently names the same handle. |
| `weights.crossSource` | `0.30` | CA present in ≥2 independent sources. |
| `weights.curated` | `0.20` | Present in a curated list (CoinGecko). |
| `weights.healthyMarket` | `0.10` | Liquidity/age look healthy (weak). |
| `minLiquidityUsd` | `10_000` | Below → `low_liquidity` (non-critical). |
| `youngPoolHours` | `24` | Below → `young_pool` (non-critical). |
| `maxSellTaxPct` | `10` | Above → `high_sell_tax` (**critical**). |
| `topHolderMaxPct` | `50` | Top non-LP/burn holder above → `top_holder_concentration` (**critical**). |

**Critical flags** (`CRITICAL_FLAGS`) block `confirmed` regardless of score and
force `abstained`: `honeypot`, `cannot_sell`, `high_sell_tax`,
`top_holder_concentration` (+ reserved non-EVM mint/freeze authority).

**How to tune:** pass a partial override to `resolveTokenForIntent(intent, {
...DEFAULT_CONFIG, confirmThreshold: 0.85 })`. To loosen for a higher-coverage
feed, lower `confirmThreshold` or set `requireXHandle: false` (NOT recommended —
it's the main anti-clone defense). Optional env overrides: `GOPLUS_API_BASE`,
`HONEYPOT_IS_API_BASE`, `GECKOTERMINAL_API_BASE`, `COINGECKO_API_BASE`.

## Where it's wired

- `src/lib/oracle-harden.ts` → `hardenProjects()` replaces each parsed signal's
  CA with the tool-resolved one (or `null` when abstained) + attaches the full
  `resolution`. Called from `/api/oracle/invoke` (prod + dev) and `/api/cron/oracle`.
- Arena (`graph.ts`) reinforcement: additive honeypot.is double-check
  (`filterConfirmedHoneypots`) — fail-open, never starves the session.

## ⚠️ Cross-repo mirror

The Oracle `/invoke` prompt + parse logic is **mirrored in `transmute-bot`**
(separate repo). The bot has its own copy and does not delegate, so this same
hardening (resolve-by-symbol + X-match gate + abstain) **must be ported to
transmute-bot** for the bot's `/invoke` to be safe too.

## Tests

`__tests__/token-resolver.test.ts` — the 7 acceptance criteria (anti-clone,
anti-hallucination, freshly-launched, divergence, fail-closed, EIP-55, single
resolution) + a config-knob test. `global.fetch` is mocked per URL so a full
resolution runs deterministically with no network.
