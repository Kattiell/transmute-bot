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
`confirmed`. The match between the narrative's official @handle and the
DEX-declared social (`info.socials`) is the primary anti-clone signal
(`requireXMatch: true`).

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
| `requireXMatch` | `true` | Hard gate: no official-X match → `abstained` (owner policy). |
| `confirmThreshold` | `0.80` | `confidence ≥` this **and** zero critical flags **and** X-match **and** security data → `confirmed`. |
| `lowConfidenceThreshold` | `0.50` | `≥` this → `low_confidence` (CA returned **with a warning**); below → `abstained`. |
| `weights.xMatch` | `0.60` | Narrative X handle == DEX X handle (strongest). |
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
feed, lower `confirmThreshold` or set `requireXMatch: false` (NOT recommended —
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
