# Token Gate — Setup Guide

Transmute Oracle bot with wallet-gated premium commands.
Premium commands (`/invoke`, `/pulse`, `/myths`, `/pearls`) require a verified wallet on Base with at least `GATE_MIN_BALANCE` tokens. `/invoke` is additionally capped at `GATE_INVOKE_DAILY_LIMIT` uses per UTC day.

Two verification paths are supported:

1. **Access code (recommended)** — user generates a 7-day single-use code in the Transmute App, then sends `/verify TXM-XXXX-XXXX` in Telegram. Codes are hashed server-side, one active per wallet, revoked when a new one is issued.
2. **Signature link** — legacy `/link` flow: bot sends a browser URL where the user connects wallet and signs an off-chain message.

## Architecture

- **transmute-bot** (Vercel) — Telegram webhook, gate middleware, blockchain checks, cron cleanup, code redemption (`/verify CODE`), daily limiter
- **nous-app** (Vercel) — Telegram Mini App at `/tg-link/[nonce]` (signature), Telegram Verification section at `/oracle/telegram` (code generation), code APIs under `/api/tg-code/*`
- **Supabase** (shared) — existing tables plus `telegram_access_codes`, `telegram_code_challenges`, `telegram_premium_daily_usage`; `telegram_wallet_links.source` column

## 1. Run the migrations

In Supabase SQL Editor, run both in order:

1. `transmute-bot/supabase-migration-telegram-gate.sql` (if not applied)
2. `transmute-bot/supabase-migration-telegram-codes.sql` (new — access codes + daily usage)

## 2. Environment variables

### transmute-bot (Vercel project)

| Name | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | BotFather token |
| `SUPABASE_URL` | yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Service role key (not anon) |
| `GATE_TOKEN_ADDRESS` | no | `0x557E...821A` | TRANSMUTE ERC-20 on Base |
| `GATE_MIN_BALANCE` | no | `25000000` | Whole tokens (integer) |
| `GATE_INVOKE_DAILY_LIMIT` | no | `3` | Max `/invoke` uses per UTC day |
| `GATE_CHAIN_ID` | no | `8453` | Base mainnet |
| `BASE_RPC_1` | no | `https://mainnet.base.org` | Primary RPC |
| `BASE_RPC_2` | no | `https://base.llamarpc.com` | Failover RPC |
| `BASE_RPC_3` | no | `https://base-rpc.publicnode.com` | Failover RPC |
| `GATE_LINK_BASE_URL` | yes | — | e.g. `https://transmute-app.vercel.app` |
| `CRON_SECRET` | yes | — | Random string for cron auth |
| `GROK_API_KEY` | yes | — | Existing, unchanged |

### nous-app (Vercel project)

| Name | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | Same Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Same service role key |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | yes | Existing |
| `GATE_TOKEN_ADDRESS` | no | Must match bot |
| `GATE_MIN_BALANCE` | no | Must match bot |
| `GATE_CHAIN_ID` | no | Must match bot |
| `BASE_RPC_1`/`_2`/`_3` | no | Same list as bot |

## 3. Deploy both projects

```bash
# transmute-bot
cd transmute-bot && vercel --prod

# nous-app
cd nous-app && vercel --prod
```

## 4. Register webhook

```bash
curl "https://<bot-deployment>/api/set-webhook?secret=<TELEGRAM_BOT_TOKEN>"
```

## 5. BotFather

No special config needed — the bot uses regular `url` inline buttons that open in the user's default browser.

## 6. User flows

### A. Access code (recommended)

1. User opens the Transmute App and navigates to **Oracle → Telegram Access** (`/oracle/telegram`).
2. Connects wallet (existing RainbowKit gate).
3. Clicks **Generate Access Code** → signs an off-chain challenge.
4. Server verifies signature + live on-chain balance (≥ `GATE_MIN_BALANCE`), revokes any prior active code for that wallet, issues a new `TXM-XXXX-XXXX` code, returns it in the response (plaintext shown once; DB stores only SHA-256 hash).
5. User opens Telegram, sends `/verify TXM-XXXX-XXXX` to the bot.
6. Bot re-checks balance live, atomically consumes the code, binds `telegram_id` to wallet, creates a 7-day `telegram_wallet_links` row with `source = 'code'`.
7. Premium commands unlocked for 7 days. `/invoke` is capped at `GATE_INVOKE_DAILY_LIMIT` per UTC day; counter auto-resets at 00:00 UTC.

### B. Signature link (legacy)

1. `/start` or `/link` — bot replies with a "Open verification page" inline button.
2. Browser opens `/tg-link/[nonce]` on nous-app; user connects wallet, signs a free message.
3. Server verifies signature + balance → stores link with `verified_until = now + 7 days` (`source = 'signature'`).
4. Premium commands unlocked; same `/invoke` daily cap applies.
5. After 7 days: middleware blocks premium, bot asks `/relink`.

## 7. Cron cleanup

Configured in `vercel.json`:
- **Path**: `/api/cron-cleanup`
- **Schedule**: `0 3 * * *` (daily 03:00 UTC)
- **Removes**: expired wallet links, expired nonces, logs > 30d, balance cache > 1h

Vercel Cron calls it with `x-vercel-cron` header. Manual trigger: `curl -H "Authorization: Bearer $CRON_SECRET" https://<bot>/api/cron-cleanup`

## 8. Commands summary

| Command | Access | Effect |
|---|---|---|
| `/start` | public | Onboarding |
| `/help` | public | List commands |
| `/verify CODE` | public (5/5min) | Redeem a code issued by the Transmute App |
| `/verify` (no args) | public | Show link status + live balance |
| `/redeem CODE` | public | Alias of `/verify CODE` |
| `/link` | public (rate limited 5/hour) | Generate nonce + signature link button |
| `/relink` | public | Same as `/link`, for re-verification |
| `/premium` | public | List premium commands |
| `/unlink` | public | Remove wallet link |
| `/invoke` | premium | Hunt microcaps — capped at `GATE_INVOKE_DAILY_LIMIT`/UTC day |
| `/pulse` | premium | Market daily report |
| `/myths` | premium | Narrative tracker |
| `/pearls` | premium | Daily wisdom |

## 9. Security features

- **Signature ownership** (both flows): nonce + EIP-191 `personal_sign`, verified server-side with `viem.verifyMessage`.
- **Hashed codes**: only SHA-256 hex stored in `telegram_access_codes.code_hash`; plaintext shown once to the user.
- **One active code per wallet**: enforced by partial unique index (`consumed_at IS NULL AND revoked_at IS NULL`) and by revoking prior active codes on new issuance.
- **Atomic consume**: `/verify CODE` uses a conditional update (`is consumed_at null`, `is revoked_at null`, `expires_at > now`) — no TOCTOU.
- **One-shot nonces**: 10-minute TTL on both `telegram_auth_nonces` and `telegram_code_challenges`, atomic consume, purged by cron.
- **Live balance re-check** at: code issuance, code redemption (bypasses cache), every premium command invocation (60s cache for middleware only).
- **Rate limits**:
  - Global bot: 20 cmds/min per telegram user
  - Premium bot: 5 premium/min per telegram user
  - `/link`: 5 per hour per telegram user
  - `/verify CODE`: 5 per 5 minutes per telegram user
  - `/invoke`: `GATE_INVOKE_DAILY_LIMIT` per UTC day per telegram user (auto-reset at 00:00 UTC)
  - Transmute-App IP: 20 code-challenge / 15 code-generate per hour per IP
- **Weekly re-verification**: `verified_until = now + 7d`, auto-purged by cron (both sources).
- **RPC failover**: 3 RPC endpoints, retry on failure.
- **Access log**: `telegram_access_log` stores all gate decisions including `tg_code_challenge`, `tg_code_generate`, `code_redeem`, `cmd:invoke` with reasons (`invalid_format`, `not_found`, `revoked`, `already_used`, `expired`, `balance_dropped`, `race_consumed`, `daily_limit_reached`).
- **Input validation**: strict regex for addresses, nonces, signatures, and code format (`TXM-[A-Z0-9]{4}-[A-Z0-9]{4}` with Crockford-style alphabet — no `0/O/1/I`).
- **RLS enabled**: all tables; only service_role reads/writes.

## 10. Monitoring

Query in Supabase:

```sql
-- Active premium users
SELECT count(*) FROM telegram_wallet_links WHERE verified_until > now();

-- Active premium users by source
SELECT source, count(*) FROM telegram_wallet_links
WHERE verified_until > now() GROUP BY source;

-- Codes issued in the last 24h
SELECT count(*) FROM telegram_access_codes
WHERE issued_at > now() - interval '24 hours';

-- Code redemption funnel
SELECT action, reason, count(*) FROM telegram_access_log
WHERE action IN ('tg_code_generate','code_redeem','cmd:invoke')
  AND created_at > now() - interval '7 days'
GROUP BY action, reason ORDER BY 3 DESC;

-- /invoke daily usage distribution (today, UTC)
SELECT count, count(*) AS users FROM telegram_premium_daily_usage
WHERE usage_date = current_date AND command = 'invoke'
GROUP BY count ORDER BY count;

-- Recent denials
SELECT action, reason, count(*) FROM telegram_access_log
WHERE success = false AND created_at > now() - interval '24 hours'
GROUP BY action, reason ORDER BY 3 DESC;

-- Balance drops (users who qualified but fell below)
SELECT * FROM telegram_access_log
WHERE reason = 'balance_dropped' AND created_at > now() - interval '7 days';
```
