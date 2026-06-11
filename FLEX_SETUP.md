# CA Auto-Cards + /flex Setup

Two features built on the `token_calls` table:

1. **CA auto-detection (RickBot-style):** when someone posts a Base contract
   address in a group, the bot replies with a live stats card (FDV, liquidity,
   volume, pair age, price) crediting the **first** person who posted that CA
   in that chat — with their entry FDV frozen as the call snapshot.
2. **`/flex [0xCA]`:** mints a 1280x720 flexcard image — token, entry FDV,
   caller, age, peak FDV reached and the multiplier in big lime type.

## 1. Run the migration

Execute `supabase-migration-token-calls.sql` in the Supabase SQL editor.
Idempotent (`IF NOT EXISTS` everywhere) — safe to re-run.

## 2. Disable BotFather privacy mode (required for auto-cards)

By default Telegram bots only receive commands in groups. For the bot to see
plain messages containing CAs, either:

- BotFather → `/setprivacy` → select the bot → **Disable**, then *remove and
  re-add the bot to each group* (Telegram caches the privacy setting per
  membership), **or**
- promote the bot to group admin (admins receive all messages).

`/flex` works regardless — it is a command.

## 3. Environment variables (all optional)

| Var | Default | Purpose |
|---|---|---|
| `CA_AUTOCALL_ENABLED` | `true` | Kill-switch for the group CA auto-card |
| `CA_CARD_COOLDOWN_SECONDS` | `1800` | Silence window per (chat, CA) after a card is sent |
| `CA_CARDS_PER_MIN_PER_CHAT` | `4` | Flood cap on cards per chat per minute |
| `VENICE_API_KEY` | — | Only needed to generate templates (https://venice.ai/settings/api) |
| `VENICE_IMAGE_MODEL` | `venice-sd35` | Venice image model id |
| `VENICE_API_BASE` | `https://api.venice.ai/api/v1` | Override for testing |

## 4. Generate the 5 background templates (Venice AI)

```bash
VENICE_API_KEY=... npm run flex:templates
```

Writes `assets/flex-templates/template-{1..5}.png`. Curate: re-run to replace
any you dislike (edit the prompts in `scripts/generate-flex-templates.ts`),
then **commit the PNGs** — Vercel bundles `assets/**` into the webhook lambda
(`vercel.json → functions → api/webhook.ts → includeFiles`).

Until templates exist, `/flex` uses 5 built-in procedural gradient backgrounds,
so the feature works immediately.

### Why Venice generates templates offline instead of composing at runtime

- Image models garble overlaid typography; the flex numbers must be crisp.
  Text is composited as vector type by `src/flex/image.ts` (resvg + bundled
  Chakra Petch fonts — Vercel lambdas have no system fonts).
- No user-controlled text ever reaches a Venice prompt → no prompt-injection
  surface, no per-call inference cost, no added latency.

## 5. How the pieces fit

- `api/webhook.ts` — group text listener (regex `0x[a-fA-F0-9]{40}`) +
  `/flex` command.
- `src/oracle/tokencalls.ts` — DB layer. First caller per (chat, CA) wins via
  unique constraint; races resolve to the same winner.
- `src/oracle/cacard.ts` — HTML card formatting (all user/token strings
  escaped before HTML parse mode).
- `src/flex/image.ts` — SVG → PNG flexcard renderer.
- `api/cron-update-ath.ts` — every 30 min also polls `token_calls` and raises
  `ath_fdv`, deduped by CA across chats; calls older than 30 days deactivate.

## 6. Anti-spam / safety model

- Card replies are throttled twice: per-(chat, CA) cooldown + per-chat
  per-minute cap (`telegram_rate_limits` bucket `cacard`).
- `/flex` is limited to 5 per user per 5 minutes (bucket `flex`).
- Unknown CAs and non-Base tokens are ignored **silently** — the bot never
  spams a group with error messages from the auto-listener.
- Existing global middleware (20 req/min/user) still applies in front.
- Usernames, token names and symbols are HTML-escaped in cards and
  glyph-sanitized in the image (emoji/unicode outside the bundled font are
  stripped to avoid tofu).
- CAs are validated by strict regex before being interpolated into the
  DexScreener URL path.

## 7. Notes / future work

- Holders / Top-holders / Fresh-wallet stats (shown by RickBot) need a data
  source beyond DexScreener (e.g. Moralis, Basescan API) — left out of v1.
- Optional runtime Venice "artistic enhancement" of the composed card was
  deliberately skipped (would blur the numbers); if wanted later, use
  Venice's upscale endpoint on the rendered PNG.
- The dev polling entry (`src/index.ts`) does not register these handlers;
  they live in the production webhook path.
