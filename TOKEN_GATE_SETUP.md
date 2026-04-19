# Token Gate — Setup Guide

Transmute Oracle bot with wallet-gated premium commands.
All 4 Oracle commands (`/invoke`, `/pulse`, `/myths`, `/pearls`) require a verified wallet on Base with at least `GATE_MIN_BALANCE` tokens.

## Architecture

- **transmute-bot** (Vercel) — Telegram webhook, gate middleware, blockchain checks, cron cleanup
- **nous-app** (Vercel) — Telegram Mini App at `/tg-link/[nonce]`, signature verification API
- **Supabase** (shared) — `telegram_users`, `telegram_wallet_links`, `telegram_auth_nonces`, `telegram_access_log`, `telegram_balance_cache`, `telegram_rate_limits`

## 1. Run the migration

In Supabase SQL Editor, paste `transmute-bot/supabase-migration-telegram-gate.sql`.

## 2. Environment variables

### transmute-bot (Vercel project)

| Name | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | BotFather token |
| `SUPABASE_URL` | yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Service role key (not anon) |
| `GATE_TOKEN_ADDRESS` | no | `0x557E...821A` | NOUS ERC-20 on Base |
| `GATE_MIN_BALANCE` | no | `25000000` | Whole tokens (integer) |
| `GATE_CHAIN_ID` | no | `8453` | Base mainnet |
| `BASE_RPC_1` | no | `https://mainnet.base.org` | Primary RPC |
| `BASE_RPC_2` | no | `https://base.llamarpc.com` | Failover RPC |
| `BASE_RPC_3` | no | `https://base-rpc.publicnode.com` | Failover RPC |
| `GATE_LINK_BASE_URL` | yes | — | e.g. `https://nous-app.vercel.app` |
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

## 6. User flow

1. `/start` — onboarding with command list
2. `/link` — bot replies with inline "Open verification page" button (opens in browser)
3. Browser opens `/tg-link/[nonce]` on nous-app
4. User connects wallet via RainbowKit (MetaMask/Coinbase/Rainbow/Trust/WalletConnect — mobile deep link or desktop QR)
5. User signs free off-chain message
6. Server verifies signature + on-chain balance → stores link with `verified_until = now + 7 days`
7. Page shows "Wallet linked successfully" — user returns to Telegram
8. Premium commands unlocked for 7 days
9. After 7 days: middleware blocks premium, bot asks `/relink`

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
| `/link` | public (rate limited 5/hour) | Generate nonce + Mini App button |
| `/relink` | public | Same as `/link`, for re-verification |
| `/verify` | public | Show link status + live balance |
| `/premium` | public | List premium commands |
| `/unlink` | public | Remove wallet link |
| `/invoke` | premium | Hunt microcaps |
| `/pulse` | premium | Market daily report |
| `/myths` | premium | Narrative tracker |
| `/pearls` | premium | Daily wisdom |

## 9. Security features

- **Signature ownership**: nonce + EIP-191 `personal_sign`, verified server-side with `viem.verifyMessage`
- **One-shot nonces**: 10-minute TTL, atomic consume, deleted on expiry
- **Rate limits**: 20 cmds/min global, 5 premium/min, 5 link attempts/hour
- **Weekly re-verification**: `verified_until = now + 7d`, auto-purged by cron
- **Live balance check**: every premium invocation re-checks balance (cached 60s)
- **RPC failover**: 3 RPC endpoints, retry on failure
- **Access log**: `telegram_access_log` stores all gate decisions (30-day retention)
- **Input validation**: regex for addresses and nonces, strict viem `isAddress`
- **RLS enabled**: all tables; only service_role writes

## 10. Monitoring

Query in Supabase:

```sql
-- Active premium users
SELECT count(*) FROM telegram_wallet_links WHERE verified_until > now();

-- Recent denials
SELECT action, reason, count(*) FROM telegram_access_log
WHERE success = false AND created_at > now() - interval '24 hours'
GROUP BY action, reason ORDER BY 3 DESC;

-- Balance drops (users who qualified but fell below)
SELECT * FROM telegram_access_log
WHERE reason = 'balance_dropped' AND created_at > now() - interval '7 days';
```
