/**
 * scripts/verify-arena-send.ts
 *
 * Self-contained contract verification for /api/internal/arena/send.
 *
 * Replicates EXACTLY what nous-app's src/lib/arena/telegram.ts:39-43 does to
 * sign payloads, then invokes the bot handler with mocked Telegraf and
 * asserts the full response shape across 5 cases:
 *
 *   1. valid HMAC + good payload → 200, sendMessage called with right args
 *   2. tampered HMAC             → 401
 *   3. malformed body            → 400
 *   4. GET method                → 405
 *   5. missing env vars          → 503
 *
 * If this script exits 0, the wire-level contract between nous-app and
 * transmute-bot is byte-identical. Run with:
 *
 *   npx tsx scripts/verify-arena-send.ts
 */

import crypto from 'node:crypto';
import Module from 'node:module';
import { strict as assert } from 'node:assert';

// ────────────────────────────────────────────────────────────────────────────
// 1) Stub Telegraf BEFORE the handler imports it.
//
// The bot caches `botSingleton = new Telegraf(token)` at module scope. We
// override `require.cache` for the `telegraf` package so the handler picks up
// our fake constructor when it lazily instantiates.
// ────────────────────────────────────────────────────────────────────────────

interface SendCall {
  chatId: number;
  text: string;
  options?: unknown;
}
const sendCalls: SendCall[] = [];

class FakeTelegram {
  async sendMessage(chatId: number, text: string, options?: unknown) {
    sendCalls.push({ chatId, text, options });
    return { message_id: 1 };
  }
}
class FakeTelegraf {
  telegram = new FakeTelegram();
  constructor(_token: string) {
    // no-op
  }
}

// Resolve the real telegraf so we replace the right cache entry.
const telegrafPath = require.resolve('telegraf');
require.cache[telegrafPath] = {
  id: telegrafPath,
  filename: telegrafPath,
  loaded: true,
  // Telegraf exports both default and named "Telegraf"; we mirror both shapes
  // so any import style resolves to the fake.
  exports: { Telegraf: FakeTelegraf, default: FakeTelegraf },
  children: [],
  paths: [],
  parent: null,
  require: Module.createRequire(telegrafPath),
} as unknown as NodeJS.Module;

// ────────────────────────────────────────────────────────────────────────────
// 2) Stub env vars exactly as nous-app would have them in prod.
// ────────────────────────────────────────────────────────────────────────────

const SECRET = 'a3f9c1b7d2e4f6a8b1c3d5e7f9a2b4c6d8e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9';
process.env.ARENA_BOT_INTERNAL_SECRET = SECRET;
process.env.TELEGRAM_BOT_TOKEN = 'fake-bot-token-for-test';

// ────────────────────────────────────────────────────────────────────────────
// 3) Replicate nous-app's sign() byte-for-byte.
//    Source: nous-app/src/lib/arena/telegram.ts:39-43
//
// IMPORTANT: keys MUST be inserted as { chatId, text, signalId } in that
// order. JSON.stringify preserves insertion order, and the bot reconstructs
// in the SAME order. Any divergence breaks the HMAC.
// ────────────────────────────────────────────────────────────────────────────

function clientSign(payload: { chatId: number; text: string; signalId: string }): string {
  return crypto
    .createHmac('sha256', SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ────────────────────────────────────────────────────────────────────────────
// 4) Minimal VercelRequest/Response shims.
// ────────────────────────────────────────────────────────────────────────────

interface FakeReq {
  method: string;
  body: unknown;
  headers: Record<string, string>;
}
interface FakeRes {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  setHeader(_k: string, _v: string): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    setHeader() {
      return this;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5) Import the handler (after the env + telegraf cache are primed).
// ────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require('../api/internal/arena/send').default as (
  req: FakeReq,
  res: FakeRes,
) => Promise<void>;

// ────────────────────────────────────────────────────────────────────────────
// 6) Test cases.
// ────────────────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`, detail ?? '');
    fail++;
  }
}

async function caseValidHmac() {
  console.log('\n[1] valid HMAC + good payload → 200');
  sendCalls.length = 0;
  const payload = {
    chatId: 12345,
    text: '🔥 CALL NOW OF THE DAY — AGENT CONSENSUS\n@transmute_signals (@vince)\n$DARKSOL at $98K',
    signalId: '11111111-2222-3333-4444-555555555555',
  };
  const body = { ...payload, hmac: clientSign(payload) };
  const res = makeRes();
  await handler(
    { method: 'POST', body, headers: { 'content-type': 'application/json' } },
    res,
  );
  check('status 200', res.statusCode === 200, res);
  check(
    'response body is { ok: true }',
    JSON.stringify(res.body) === '{"ok":true}',
    res.body,
  );
  check('sendMessage called once', sendCalls.length === 1);
  check(
    'sendMessage chatId matches',
    sendCalls[0]?.chatId === payload.chatId,
    sendCalls[0],
  );
  check(
    'sendMessage text matches (byte-exact)',
    sendCalls[0]?.text === payload.text,
    {
      sent: sendCalls[0]?.text,
      expected: payload.text,
    },
  );
}

async function caseTamperedHmac() {
  console.log('\n[2] tampered HMAC → 401');
  sendCalls.length = 0;
  const payload = { chatId: 1, text: 'x', signalId: 'sig' };
  const real = clientSign(payload);
  // Flip one hex char.
  const tampered = real.slice(0, -1) + (real.endsWith('0') ? '1' : '0');
  const body = { ...payload, hmac: tampered };
  const res = makeRes();
  await handler(
    { method: 'POST', body, headers: { 'content-type': 'application/json' } },
    res,
  );
  check('status 401', res.statusCode === 401, res);
  check(
    'error is invalid_signature',
    (res.body as { error?: string })?.error === 'invalid_signature',
    res.body,
  );
  check('no Telegram send', sendCalls.length === 0);
}

async function caseMalformedBody() {
  console.log('\n[3] malformed body → 400');
  sendCalls.length = 0;
  // Missing required fields.
  const res = makeRes();
  await handler(
    { method: 'POST', body: { chatId: 'not-a-number' }, headers: {} },
    res,
  );
  check('status 400', res.statusCode === 400, res);
  check(
    'error is invalid_payload',
    (res.body as { error?: string })?.error === 'invalid_payload',
    res.body,
  );
  check('no Telegram send', sendCalls.length === 0);
}

async function caseGetMethod() {
  console.log('\n[4] GET method → 405');
  sendCalls.length = 0;
  const res = makeRes();
  await handler({ method: 'GET', body: undefined, headers: {} }, res);
  check('status 405', res.statusCode === 405, res);
  check(
    'error is method_not_allowed',
    (res.body as { error?: string })?.error === 'method_not_allowed',
    res.body,
  );
}

async function caseMissingEnv() {
  console.log('\n[5] missing env → 503');
  sendCalls.length = 0;
  const prevSecret = process.env.ARENA_BOT_INTERNAL_SECRET;
  delete process.env.ARENA_BOT_INTERNAL_SECRET;
  // Re-require fresh module so it picks up the cleared env on import path.
  // The handler reads env at request time, so just calling it suffices.
  const payload = { chatId: 1, text: 'x', signalId: 'sig' };
  const body = { ...payload, hmac: 'a'.repeat(64) };
  const res = makeRes();
  await handler(
    { method: 'POST', body, headers: { 'content-type': 'application/json' } },
    res,
  );
  check('status 503', res.statusCode === 503, res);
  check(
    'error is service_unavailable',
    (res.body as { error?: string })?.error === 'service_unavailable',
    res.body,
  );
  process.env.ARENA_BOT_INTERNAL_SECRET = prevSecret;
}

async function caseLengthInvariants() {
  console.log('\n[6] HMAC determinism + length invariants');
  const a = clientSign({ chatId: 1, text: 'hello', signalId: 'abc' });
  const b = clientSign({ chatId: 1, text: 'hello', signalId: 'abc' });
  check('sign() is deterministic', a === b);
  check('sign() returns 64 hex chars', /^[0-9a-f]{64}$/.test(a));
  const c = clientSign({ chatId: 2, text: 'hello', signalId: 'abc' });
  check('different chatId → different sig', a !== c);
}

(async () => {
  console.log('═══════════════════════════════════════════════');
  console.log(' Arena send contract verification');
  console.log('═══════════════════════════════════════════════');
  try {
    await caseValidHmac();
    await caseTamperedHmac();
    await caseMalformedBody();
    await caseGetMethod();
    await caseMissingEnv();
    await caseLengthInvariants();
  } catch (e) {
    console.error('\n✗ harness threw:', e);
    process.exit(2);
  }
  console.log('\n═══════════════════════════════════════════════');
  console.log(` Results: ${pass} passed, ${fail} failed`);
  console.log('═══════════════════════════════════════════════');
  assert.equal(fail, 0, 'one or more contract checks failed');
  process.exit(0);
})();
