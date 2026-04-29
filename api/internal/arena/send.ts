/**
 * POST /api/internal/arena/send
 *
 * Inbound Telegram dispatch for the Agent Arena feature in nous-app. Each
 * Call Now signal triggers nous-app to fan-out one POST per eligible holder
 * (>=50M $TRANSMUTE re-checked on-chain at delivery time). Auth is via
 * HMAC-SHA256 over the canonical payload `{ chatId, text, signalId }`. The
 * bot is the sole owner of TELEGRAM_BOT_TOKEN — nous-app never holds it.
 *
 * Contract (must match src/lib/arena/telegram.ts on the nous-app side):
 *   request body  { chatId: number, text: string, signalId: string, hmac: string }
 *   hmac          = hex(HMAC_SHA256(ARENA_BOT_INTERNAL_SECRET, JSON.stringify({chatId,text,signalId})))
 *   200           delivered
 *   400           malformed body / oversize text
 *   401           bad/missing signature
 *   404           chat unreachable (blocked, deleted, etc.) — client gives up
 *   429 {retryAfter} flood-control — client retries once honoring delay
 *   502           transient Telegram error — client retries once
 *   503           service not configured — client treats as retryable
 *
 * SECURITY:
 *   - Constant-time HMAC comparison (timingSafeEqual) — no timing oracle.
 *   - Strict input validation BEFORE the HMAC check, so we don't burn cycles
 *     on garbage and don't get tricked by exotic types.
 *   - chatId / text / signalId are NEVER logged in clear.
 *   - parse_mode is intentionally omitted — the Call Now is plain text and
 *     leaving HTML/Markdown off prevents injection if `text` ever carries
 *     untrusted special chars.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { Telegraf } from 'telegraf';

// Read env at call time (not at module load) so:
//   1) env-var rotation works without a redeploy,
//   2) the verification harness in scripts/verify-arena-send.ts can mutate
//      env between cases without re-importing the module.
// This mirrors src/lib/arena/telegram.ts on the nous-app side.
const getToken = () => process.env.TELEGRAM_BOT_TOKEN;
const getSecret = () => process.env.ARENA_BOT_INTERNAL_SECRET;

// Telegram caps a single message at 4096 chars. The Call Now is ~10 short
// lines (well under), so this is a defensive ceiling, not a tight bound.
const MAX_TEXT_LENGTH = 4096;
// Loose ceiling for signalId. Real values are UUIDs (36 chars).
const MAX_SIGNAL_ID_LENGTH = 200;

// Reuse the Telegraf instance across warm invocations to avoid re-paying the
// init cost on every request. Telegraf only opens an HTTP client; it does not
// start polling unless launch() is called. Re-init if the token changes
// (rotation), to avoid a stale client clinging to a revoked token.
let botSingleton: Telegraf | null = null;
let botToken: string | null = null;
function getBot(): Telegraf | null {
  const token = getToken();
  if (!token) return null;
  if (!botSingleton || botToken !== token) {
    botSingleton = new Telegraf(token);
    botToken = token;
  }
  return botSingleton;
}

interface InboundPayload {
  chatId: number;
  text: string;
  signalId: string;
  hmac: string;
}

function isInboundPayload(b: unknown): b is InboundPayload {
  if (!b || typeof b !== 'object') return false;
  const p = b as Record<string, unknown>;
  return (
    typeof p.chatId === 'number' &&
    Number.isFinite(p.chatId) &&
    Number.isInteger(p.chatId) &&
    typeof p.text === 'string' &&
    p.text.length > 0 &&
    p.text.length <= MAX_TEXT_LENGTH &&
    typeof p.signalId === 'string' &&
    p.signalId.length > 0 &&
    p.signalId.length <= MAX_SIGNAL_ID_LENGTH &&
    typeof p.hmac === 'string' &&
    /^[0-9a-f]{64}$/.test(p.hmac)
  );
}

/**
 * HMAC verification. Recomputes the signature locally over the EXACT shape
 * `{ chatId, text, signalId }` (key order matters because we hash JSON bytes)
 * and compares constant-time. Any throw → reject.
 */
function verifyHmac(payload: InboundPayload): boolean {
  const secret = getSecret();
  if (!secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(
      JSON.stringify({
        chatId: payload.chatId,
        text: payload.text,
        signalId: payload.signalId,
      }),
    )
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(payload.hmac, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function truncSignal(id: string): string {
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

interface TelegramErrorShape {
  code?: number;
  description?: string;
  response?: { parameters?: { retry_after?: number } };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Required env not configured. 503 keeps it in the client's retry set, so
  // the moment ops finishes the rollout the next attempt delivers without a
  // manual replay.
  if (!getSecret() || !getToken()) {
    return res.status(503).json({ error: 'service_unavailable' });
  }

  // Vercel parses application/json bodies for us. We still defensively
  // re-check the shape — a buggy client or a misrouted request can produce
  // unexpected shapes.
  const body = req.body as unknown;
  if (!isInboundPayload(body)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  if (!verifyHmac(body)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const bot = getBot();
  if (!bot) return res.status(503).json({ error: 'service_unavailable' });

  try {
    await bot.telegram.sendMessage(body.chatId, body.text, {
      // Plain text on purpose — Call Now is plain text and we DO NOT want to
      // interpret HTML/Markdown in case `text` ever carries `<`/`&`.
      // @ts-expect-error - Telegraf types may lag the API
      disable_web_page_preview: true,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    const e = err as TelegramErrorShape;
    const code = e.code ?? 0;
    if (code === 429) {
      const retry = e.response?.parameters?.retry_after ?? 1;
      return res.status(429).json({ error: 'rate_limited', retryAfter: Math.min(retry, 60) });
    }
    if (code === 400 || code === 403) {
      console.warn('[arena/send] permanent_failure', {
        signalId: truncSignal(body.signalId),
        code,
      });
      return res.status(404).json({ error: 'chat_unreachable' });
    }
    console.error('[arena/send] telegram_error', {
      signalId: truncSignal(body.signalId),
      code,
    });
    return res.status(502).json({ error: 'telegram_error' });
  }
}
