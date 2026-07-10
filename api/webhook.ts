import type { Context } from 'telegraf';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { Telegraf } from 'telegraf';
import { timingSafeEqual } from 'node:crypto';
import { invokeOracle, invokeOracleWithPrompt } from '../src/grok';
import { parseOracleOutput } from '../src/parser';
import { hardenProjects } from '../src/oracle-harden';
import { formatWhispersReport, formatGenericReport } from '../src/formatter';
import { PULSE_PROMPT, MYTHS_PROMPT, PEARLS_PROMPT, buildHorusPrompt } from '../src/prompts';
import {
  identityMiddleware,
  globalRateLimitMiddleware,
  premiumGateMiddleware,
} from '../src/gate/middleware';
import { registerGateCommands, handleStart, buildHelpMessage } from '../src/gate/commands';
import {
  checkAndIncrementDailyUsage,
  checkRateLimit,
  claimTelegramUpdate,
  clearPendingOracle,
  getPendingOracle,
  getWalletLink,
  isLinkExpired,
  logAccess,
  setPendingOracle,
} from '../src/gate/db';
import { getTokenBalance, formatTokenAmount } from '../src/gate/blockchain';
import { DAILY_LIMITS, GATE_CONFIG, getAdminTelegramIds, isAdmin, isExemptWallet } from '../src/gate/config';
import {
  fetchDexScreenerSnapshot,
  isValidEvmAddress,
  snapshotToPromptBlock,
} from '../src/dexscreener';
import {
  BASE_CHAIN,
  ROBINHOOD_CHAIN,
  SUPPORTED_CHAINS,
  chainByKey,
  chainByRefreshTag,
  type ChainInfo,
} from '../src/chains';
import { fetchTokenSnapshot } from '../src/tokensnapshot';
import {
  addGroupSubscription,
  clearPendingCall,
  createApprovedCall,
  createCallSubmission,
  getPendingCall,
  getSubmission,
  isGroupSubscribed,
  listActiveGroupIds,
  listCallsInWindow,
  listOptedInDmTargets,
  markGroupLeft,
  markSubmissionReviewed,
  recentCallByCaller,
  removeGroupSubscription,
  setDmOptOut,
  setPendingCallStep,
  upsertGroupMembership,
} from '../src/oracle/calls';
import {
  formatAdminReviewMessage,
  formatCallAlert,
  formatPantheonLeaderboard,
} from '../src/oracle/format';
import {
  getEarliestTokenCall,
  getLatestTokenCallForChat,
  getTokenCall,
  markTokenCallCardSent,
  raiseTokenCallAthByCa,
  recordTokenCall,
  type TokenCall,
} from '../src/oracle/tokencalls';
import {
  callerHandle,
  callMultiplier,
  fmtAge,
  formatCaCard,
  formatFlexFallback,
  reachedFdv,
} from '../src/oracle/cacard';
import { renderFlexCard } from '../src/flex/image';

const token = process.env.TELEGRAM_BOT_TOKEN!;
// Default Telegraf handlerTimeout is 90s; /invoke can take 1-3 min in the
// Grok web_search call. Push it to just under the Vercel Lambda limit (300s)
// so the oracle finishes and the final report actually sends.
const bot = new Telegraf(token, { handlerTimeout: 290_000 });

bot.use(identityMiddleware);
bot.use(globalRateLimitMiddleware);
bot.use(premiumGateMiddleware);

// Telegram throttles bots to ~20 msgs/min per group (1 per ~3s). In private
// chats the limit is ~1/sec. Spacing sends below these caps avoids 429 storms
// that can stretch a multi-message report to 10+ minutes in groups.
async function sendMessages(
  chatId: number,
  messages: string[],
  chatType: 'private' | 'group' | 'supergroup' | 'channel' = 'private',
): Promise<void> {
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const delayMs = isGroup ? 3100 : 500;

  for (const msg of messages) {
    if (!msg.trim()) continue;
    try {
      await bot.telegram.sendMessage(chatId, msg, {
        parse_mode: 'HTML',
        // @ts-expect-error - Telegraf types may lag behind API
        disable_web_page_preview: true,
      });
    } catch {
      const plain = msg.replace(/<[^>]+>/g, '');
      await bot.telegram.sendMessage(chatId, plain);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

bot.start(async (ctx) => {
  // Deep link from the CA card's "Call Now" button:
  // https://t.me/<bot>?start=callnow → jump straight into the wizard.
  const msg = ctx.message;
  const text = msg && 'text' in msg ? msg.text : '';
  const payload = text.replace(/^\/start(@\w+)?/i, '').trim().toLowerCase();
  if (payload === 'callnow' && ctx.chat?.type === 'private') {
    // /start bypasses the premium gate middleware, so re-check entitlement
    // here the same way the conversational flows do.
    if (!(await ensurePremiumActive(ctx))) return;
    await beginCallNowWizard(ctx);
    return;
  }
  await handleStart(ctx);
});
bot.help((ctx) => ctx.reply(buildHelpMessage(), { parse_mode: 'HTML' }));

registerGateCommands(bot);

bot.command('invoke', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  const maxPerDay = DAILY_LIMITS.invoke ?? 3;
  const link = await getWalletLink(from.id).catch(() => null);
  let usage: Awaited<ReturnType<typeof checkAndIncrementDailyUsage>>;
  try {
    usage = await checkAndIncrementDailyUsage(from.id, 'invoke', maxPerDay, link?.wallet_address);
  } catch (err) {
    console.error('[invoke] daily usage check failed', err);
    await ctx.reply('⚠️ Could not verify daily usage. Please try again.');
    return;
  }

  if (!usage.allowed) {
    const resetMs = new Date(usage.resetAt).getTime() - Date.now();
    const hours = Math.floor(resetMs / 3600_000);
    const minutes = Math.floor((resetMs % 3600_000) / 60_000);
    await logAccess({
      telegramId: from.id,
      action: 'cmd:invoke',
      success: false,
      reason: 'daily_limit_reached',
      metadata: { count: usage.count, max: usage.max },
    });
    await ctx.reply(
      `⏳ <b>Daily /invoke limit reached.</b>\n\n` +
        `You've used <b>${usage.count}/${usage.max}</b> today.\n` +
        `Resets in <b>${hours}h ${minutes}m</b> (00:00 UTC).`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  try {
    const usesLine = usage.unlimited
      ? 'Uses today: <b>∞ (unlimited)</b>'
      : `Uses today: <b>${usage.count}/${usage.max}</b>`;
    await ctx.reply(
      `🔮 <b>Invoking the Oracle...</b>\n` +
        `<i>Scanning Base chain for hidden microcaps. This may take 1-3 minutes.</i>\n\n` +
        usesLine,
      { parse_mode: 'HTML' },
    );

    const tOracleStart = Date.now();
    const raw = await invokeOracle();
    console.log(`[invoke] oracle done in ${Date.now() - tOracleStart}ms chat=${ctx.chat.type}`);

    const projects = parseOracleOutput(raw);

    const tSendStart = Date.now();
    if (projects.length === 0) {
      const messages = formatGenericReport('ORACLE SCAN REPORT', raw);
      await sendMessages(ctx.chat.id, messages, ctx.chat.type);
    } else {
      // Harden: tool-resolve each CA (or abstain) before formatting. The card
      // renderer reads project.resolution (I1 — never the model's CA), so passing
      // un-hardened ParsedProjects makes contractSection() read `undefined` and
      // throw, which surfaced to users as "The Oracle encountered an error".
      const hardened = await hardenProjects(projects);
      await sendMessages(ctx.chat.id, formatWhispersReport(hardened), ctx.chat.type);
    }
    console.log(`[invoke] send done in ${Date.now() - tSendStart}ms projects=${projects.length}`);
  } catch (err) {
    console.error('[invoke]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

bot.command('pulse', async (ctx) => {
  try {
    await ctx.reply('📊 <b>Channeling the Pulse...</b>\n<i>Aggregating macro, sentiment, and on-chain flows. 1-3 minutes.</i>', { parse_mode: 'HTML' });
    const raw = await invokeOracleWithPrompt(PULSE_PROMPT);
    await sendMessages(ctx.chat.id, formatGenericReport('MARKET DAILY REPORT', raw), ctx.chat.type);
  } catch (err) {
    console.error('[pulse]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

bot.command('myths', async (ctx) => {
  try {
    await ctx.reply('🌀 <b>Unveiling the Myths...</b>\n<i>Tracking living narratives. 1-3 minutes.</i>', { parse_mode: 'HTML' });
    const raw = await invokeOracleWithPrompt(MYTHS_PROMPT);
    await sendMessages(ctx.chat.id, formatGenericReport('NARRATIVE TRACKER', raw), ctx.chat.type);
  } catch (err) {
    console.error('[myths]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

bot.command('pearls', async (ctx) => {
  try {
    await ctx.reply('💎 <b>Summoning a Pearl...</b>\n<i>The Oracle prepares a teaching. 1-2 minutes.</i>', { parse_mode: 'HTML' });
    const raw = await invokeOracleWithPrompt(PEARLS_PROMPT);
    await sendMessages(ctx.chat.id, formatGenericReport('PEARL OF KNOWLEDGE', raw), ctx.chat.type);
  } catch (err) {
    console.error('[pearls]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

/**
 * Re-runs the wallet/balance check the premium gate middleware enforces for
 * commands. The /oracle conversational flow can complete via a plain text
 * message (no command), so the middleware does not fire and we must verify
 * the seeker is still entitled before invoking Grok.
 */
async function ensurePremiumActive(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  if (!from) return false;
  const link = await getWalletLink(from.id);
  if (!link) {
    await ctx.reply(
      `🔒 <b>Premium command.</b>\n\nLink a wallet holding at least <b>${GATE_CONFIG.minBalance.toLocaleString('en-US')} $TRANSMUTE</b> on Base. Run /link.`,
      { parse_mode: 'HTML' },
    );
    return false;
  }
  if (isLinkExpired(link)) {
    await ctx.reply('⏰ <b>Verification expired.</b> Run /relink.', { parse_mode: 'HTML' });
    return false;
  }
  // God-mode wallets skip the on-chain balance gate, same as the middleware.
  if (!isExemptWallet(link.wallet_address)) {
    try {
      const balance = await getTokenBalance(link.wallet_address);
      if (!balance.meetsMinimum) {
        await ctx.reply(
          `❌ <b>Insufficient balance.</b>\nCurrent: <b>${formatTokenAmount(balance.raw, balance.decimals)}</b> $TRANSMUTE`,
          { parse_mode: 'HTML' },
        );
        return false;
      }
    } catch {
      await ctx.reply('⚠️ Could not verify balance right now. Try again shortly.');
      return false;
    }
  }
  return true;
}

async function runOracleRevelation(ctx: Context, ca: string): Promise<void> {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const normalizedCa = ca.trim().toLowerCase();

  if (!isValidEvmAddress(normalizedCa)) {
    await ctx.reply(
      '❌ <b>Invalid contract address.</b>\n\nExpected a 0x-prefixed 40-character hex address.\n\nExample: <code>/oracle 0x557E8f1cd9fB4e9dfEcA817b15B737328D90821A</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const maxPerDay = DAILY_LIMITS.oracle ?? 5;
  const link = await getWalletLink(from.id).catch(() => null);
  let usage: Awaited<ReturnType<typeof checkAndIncrementDailyUsage>>;
  try {
    usage = await checkAndIncrementDailyUsage(from.id, 'oracle', maxPerDay, link?.wallet_address);
  } catch (err) {
    console.error('[oracle] daily usage check failed', err);
    await ctx.reply('⚠️ Could not verify daily usage. Please try again.');
    return;
  }

  if (!usage.allowed) {
    const resetMs = new Date(usage.resetAt).getTime() - Date.now();
    const hours = Math.floor(resetMs / 3600_000);
    const minutes = Math.floor((resetMs % 3600_000) / 60_000);
    await logAccess({
      telegramId: from.id,
      action: 'cmd:oracle',
      success: false,
      reason: 'daily_limit_reached',
      metadata: { count: usage.count, max: usage.max, ca: normalizedCa },
    });
    await ctx.reply(
      `⏳ <b>Daily /oracle limit reached.</b>\n\n` +
        `You've used <b>${usage.count}/${usage.max}</b> today.\n` +
        `Resets in <b>${hours}h ${minutes}m</b> (00:00 UTC).`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const usesLine = usage.unlimited
    ? 'Uses today: <b>∞ (unlimited)</b>'
    : `Uses today: <b>${usage.count}/${usage.max}</b>`;

  await ctx.reply(
    `𓂀 <b>The Eye of Horus opens...</b>\n` +
      `<i>Piercing the veil of <code>${normalizedCa.slice(0, 10)}...${normalizedCa.slice(-6)}</code>. 1-3 minutes.</i>\n\n` +
      usesLine,
    { parse_mode: 'HTML' },
  );

  // Fetch DexScreener concurrently with the user message ack so Grok gets
  // ground-truth FDV/liquidity numbers instead of fabricating them. The CA is
  // resolved against Base first, then Robinhood — the analysis is framed for
  // whichever network actually holds the pair.
  const tStart = Date.now();
  const resolved = await fetchTokenSnapshot(normalizedCa, SUPPORTED_CHAINS);
  const snapshot = resolved?.snapshot ?? null;
  const dexBlock = snapshot ? snapshotToPromptBlock(snapshot) : null;
  const oracleChain = resolved?.chain ?? BASE_CHAIN;
  console.log(
    `[oracle] dex snapshot ${snapshot ? `ok (${oracleChain.key})` : 'missing'} in ${Date.now() - tStart}ms`,
  );

  if (!snapshot) {
    // Token might be too new or on an uncovered network — warn the seeker but
    // still let Grok try.
    await ctx.reply(
      '⚠️ <i>Neither DexScreener nor GeckoTerminal returned a Base or Robinhood pair for this CA. Horus will analyze with thin data — the verdict may flag higher risk.</i>',
      { parse_mode: 'HTML' },
    );
  }

  try {
    const tGrok = Date.now();
    const prompt = buildHorusPrompt({
      ca: normalizedCa,
      dexSnapshot: dexBlock,
      chain: { label: oracleChain.label, explorerName: oracleChain.explorerName },
    });
    const raw = await invokeOracleWithPrompt(prompt);
    console.log(`[oracle] grok done in ${Date.now() - tGrok}ms`);

    await sendMessages(chatId, formatGenericReport('ORACULAR REVELATION', raw), chatType);
  } catch (err) {
    console.error('[oracle] grok call failed', err);
    await ctx.reply('❌ The Eye of Horus closed unexpectedly. Try again shortly.');
  }
}

bot.command('oracle', async (ctx) => {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  const msg = ctx.message;
  const text = msg && 'text' in msg ? msg.text : '';
  const arg = text.replace(/^\/oracle(@\w+)?/i, '').trim();

  if (arg) {
    await runOracleRevelation(ctx, arg);
    await clearPendingOracle(from.id).catch(() => undefined);
    return;
  }

  // Bare /oracle — only support conversational mode in DMs to avoid
  // ambiguity in groups (multiple users could be mid-flow simultaneously,
  // and a plain CA in a group is rarely directed at the bot).
  if (ctx.chat.type !== 'private') {
    await ctx.reply(
      '𓂀 <b>Horus Oracle</b>\n\nIn groups, send the address inline:\n<code>/oracle 0xYourContractAddress</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  await setPendingOracle(from.id, 300).catch((err) => {
    console.error('[oracle] setPendingOracle failed', err);
  });
  await ctx.reply(
    '𓂀 <b>Horus awaits the address.</b>\n\nSend the contract address (CA) of the Base or Robinhood token you want revealed. The Eye listens for 5 minutes.\n\n<i>Tip: paste only the address, e.g. <code>0x557E8f1cd9fB4e9dfEcA817b15B737328D90821A</code></i>',
    { parse_mode: 'HTML' },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// /callnow — Pantheon submission wizard
// ─────────────────────────────────────────────────────────────────────────────

const THESIS_MAX_LEN = 150;
const CALLNOW_COOLDOWN_SECONDS = 6 * 3600; // 6h between submissions per user
const MIN_LIQUIDITY_USD = parseInt(process.env.CALLNOW_MIN_LIQUIDITY_USD || '500', 10);

/** Starts the /callnow wizard. Shared by the command and the ?start=callnow deep link. */
async function beginCallNowWizard(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const recent = await recentCallByCaller(from.id, CALLNOW_COOLDOWN_SECONDS).catch(() => null);
  if (recent) {
    const sinceMs = Date.now() - new Date(recent.created_at).getTime();
    const remaining = Math.max(0, CALLNOW_COOLDOWN_SECONDS * 1000 - sinceMs);
    const hours = Math.floor(remaining / 3600_000);
    const minutes = Math.floor((remaining % 3600_000) / 60_000);
    await ctx.reply(
      `⏳ <b>Cooldown active.</b>\nLast submission: <i>${recent.status}</i>. Try again in <b>${hours}h ${minutes}m</b>.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  await setPendingCallStep({
    telegramId: from.id,
    step: 'awaiting_ca',
    ttlSeconds: 600,
  });
  await ctx.reply(
    '𓂀 <b>The Pantheon listens.</b>\n\n' +
      'Send the <b>contract address</b> (CA) of the Base token you wish to call.\n\n' +
      '<i>Step 1 of 2 — 10 minutes to respond.</i>',
    { parse_mode: 'HTML' },
  );
}

bot.command('callnow', async (ctx) => {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  if (ctx.chat.type !== 'private') {
    await ctx.reply(
      '𓂀 <b>Call Now</b>\n\nThe ritual is private. Open a DM with the Oracle and run /callnow there.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  await beginCallNowWizard(ctx);
});

async function handleCallWizardCa(
  ctx: Context,
  rawCa: string,
): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const ca = rawCa.trim().toLowerCase();
  if (!isValidEvmAddress(ca)) {
    await ctx.reply(
      '❓ That doesn\'t look like a Base contract address. Send a 0x-prefixed 40-character hex string. Run /callnow again to cancel.',
    );
    return;
  }

  await ctx.reply('🔍 <i>Scanning DexScreener…</i>', { parse_mode: 'HTML' });
  const snap = await fetchDexScreenerSnapshot(ca);
  if (!snap) {
    await ctx.reply(
      '❌ <b>No Base pair found on DexScreener.</b>\n\nThe token must be tradable on Base. Run /callnow again to try another.',
      { parse_mode: 'HTML' },
    );
    await clearPendingCall(from.id).catch(() => undefined);
    return;
  }
  if ((snap.liquidityUsd ?? 0) < MIN_LIQUIDITY_USD) {
    await ctx.reply(
      `❌ <b>Liquidity too thin.</b>\nFound: ~$${(snap.liquidityUsd ?? 0).toFixed(0)} (min: $${MIN_LIQUIDITY_USD}).\n\n<i>Pick a token with real depth.</i>`,
      { parse_mode: 'HTML' },
    );
    await clearPendingCall(from.id).catch(() => undefined);
    return;
  }

  await setPendingCallStep({
    telegramId: from.id,
    step: 'awaiting_thesis',
    ca,
    ticker: snap.symbol,
    name: snap.name,
    fdvUsd: snap.fdvUsd,
    liquidityUsd: snap.liquidityUsd,
    ttlSeconds: 600,
  });

  await ctx.reply(
    [
      `✅ <b>$${snap.symbol}</b> — <i>${snap.name}</i>`,
      `FDV: <b>$${(snap.fdvUsd ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>`,
      `Liquidity: <b>$${(snap.liquidityUsd ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>`,
      '',
      `📜 <b>Now write your thesis.</b>`,
      `Why is this Alpha? Up to <b>${THESIS_MAX_LEN} characters</b>.`,
      '',
      `<i>Step 2 of 2.</i>`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}

async function handleCallWizardThesis(
  ctx: Context,
  pending: { ca: string | null; ticker: string | null; name: string | null; fdv_usd: number | null; liquidity_usd: number | null },
  thesisRaw: string,
): Promise<void> {
  const from = ctx.from;
  if (!from || !pending.ca) return;
  const thesis = thesisRaw.trim();
  if (thesis.length < 20) {
    await ctx.reply('🤏 Too short. Give the council at least <b>20 characters</b> of substance.', { parse_mode: 'HTML' });
    return;
  }
  if (thesis.length > THESIS_MAX_LEN) {
    await ctx.reply(
      `✂️ Too long (${thesis.length}/${THESIS_MAX_LEN}). Cut it down and try again.`,
    );
    return;
  }

  let submission;
  try {
    submission = await createCallSubmission({
      callerTelegramId: from.id,
      callerUsername: from.username ?? null,
      callerFirstName: from.first_name ?? null,
      contractAddress: pending.ca,
      ticker: pending.ticker,
      name: pending.name,
      thesis,
      fdvAtSubmit: pending.fdv_usd,
      liquidityAtSubmit: pending.liquidity_usd,
    });
  } catch (err) {
    console.error('[callnow] createCallSubmission failed', err);
    await ctx.reply('⚠️ Could not record your submission. Try again shortly.');
    return;
  }

  await clearPendingCall(from.id).catch(() => undefined);

  await ctx.reply(
    '📜 <b>Thesis received. The Pantheon will judge.</b>\n\n<i>You will be notified when the council reviews.</i>',
    { parse_mode: 'HTML' },
  );

  // Notify admins in DM with inline approve/reject buttons.
  const admins = getAdminTelegramIds();
  if (admins.length === 0) {
    console.warn('[callnow] no ADMIN_TELEGRAM_IDS configured — submission stored but unreviewable');
    return;
  }
  const adminText = formatAdminReviewMessage(submission);
  for (const adminId of admins) {
    try {
      await bot.telegram.sendMessage(adminId, adminText, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `cn:ap:${submission.id}` },
              { text: '❌ Reject', callback_data: `cn:rj:${submission.id}` },
            ],
          ],
        },
        // @ts-expect-error - Telegraf types may lag behind API
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error(`[callnow] failed to notify admin ${adminId}`, err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /gods leaderboard
// ─────────────────────────────────────────────────────────────────────────────

bot.command('gods', async (ctx) => {
  if (!ctx.chat) return;
  const msg = ctx.message;
  const text = msg && 'text' in msg ? msg.text : '';
  const arg = text.replace(/^\/gods(@\w+)?/i, '').trim().toLowerCase();

  let days = 7;
  let label = '7D';
  if (arg === '30d' || arg === '30') {
    days = 30;
    label = '30D';
  } else if (arg === 'all' || arg === 'lifetime') {
    days = 365 * 5;
    label = 'ALL-TIME';
  } else if (arg === '24h' || arg === '1d') {
    days = 1;
    label = '24H';
  }

  try {
    const calls = await listCallsInWindow(days, 250);
    const leaderboard = formatPantheonLeaderboard({ calls, windowLabel: label });
    await ctx.reply(leaderboard, {
      parse_mode: 'HTML',
      // @ts-expect-error - Telegraf types may lag behind API
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[gods]', err);
    await ctx.reply('⚠️ Could not load the Pantheon right now. Try again shortly.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /flex — flexcard image for a tracked group call
// ─────────────────────────────────────────────────────────────────────────────

bot.command('flex', async (ctx) => {
  const from = ctx.from;
  const chat = ctx.chat;
  if (!from || !chat) return;

  // Image rendering is CPU work on the lambda — keep a lid on per-user volume.
  const { allowed } = await checkRateLimit(from.id, 'flex', 300, 5).catch(() => ({ allowed: true }));
  if (!allowed) {
    await ctx.reply('⏳ Easy, flexer — max 5 cards per 5 minutes.');
    return;
  }

  const msg = ctx.message;
  const text = msg && 'text' in msg ? msg.text : '';
  const arg = text.replace(/^\/flex(@\w+)?/i, '').trim().split(/\s+/)[0] ?? '';
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';

  let call: TokenCall | null = null;
  if (arg) {
    const ca = arg.toLowerCase();
    if (!isValidEvmAddress(ca)) {
      await ctx.reply(
        '🎴 <b>Flex</b>\n\nUsage: <code>/flex 0xContractAddress</code>\nOr bare <code>/flex</code> in a group to flex its latest call.',
        { parse_mode: 'HTML' },
      );
      return;
    }
    // Prefer this group's own call; fall back to the earliest call anywhere.
    call = isGroup ? await getTokenCall(chat.id, ca).catch(() => null) : null;
    if (!call) call = await getEarliestTokenCall(ca).catch(() => null);
  } else if (isGroup) {
    call = await getLatestTokenCallForChat(chat.id).catch(() => null);
  } else {
    await ctx.reply(
      '🎴 <b>Flex</b>\n\nSend <code>/flex 0xContractAddress</code> — the CA must have been called in a group the Oracle watches.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (!call) {
    await ctx.reply(
      '🎴 <b>No tracked call for that token.</b>\n\nPost the CA in a group with the Oracle first — the call (and its FDV snapshot) gets recorded automatically.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  await ctx.sendChatAction('upload_photo').catch(() => undefined);

  // Fresh snapshot for the live FDV; opportunistically raise the stored peak
  // so the card never understates the multiplier between cron runs.
  const snap = await fetchTokenSnapshot(call.contract_address, [chainByKey(call.chain)])
    .then((r) => r?.snapshot ?? null)
    .catch(() => null);
  const currentFdv = snap?.fdvUsd ?? null;
  if (currentFdv !== null && currentFdv > (call.ath_fdv ?? 0)) {
    await raiseTokenCallAthByCa({
      contractAddress: call.contract_address,
      newAthFdv: currentFdv,
      newAthPriceUsd: snap?.priceUsd ?? null,
    }).catch(() => undefined);
    call = { ...call, ath_fdv: currentFdv, ath_price_usd: snap?.priceUsd ?? null };
  }

  const caption = formatFlexFallback({ call, currentFdv });
  try {
    const png = await renderFlexCard({
      ticker: call.ticker || snap?.symbol || call.name || 'TOKEN',
      fdvAtCall: call.fdv_at_call,
      reachedFdv: reachedFdv(call, currentFdv),
      multiplier: callMultiplier(call, currentFdv),
      ageLabel: fmtAge(call.called_at),
      caller: callerHandle(call),
    });
    await ctx.replyWithPhoto(
      { source: png, filename: 'transmute-flex.png' },
      { caption, parse_mode: 'HTML' },
    );
  } catch (err) {
    console.error('[flex] render failed', err);
    await ctx.reply(caption, { parse_mode: 'HTML' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Group broadcast opt-in
// ─────────────────────────────────────────────────────────────────────────────

async function callerIsGroupAdmin(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  if (!from || !ctx.chat) return false;
  if (ctx.chat.type === 'private') return false;
  try {
    const member = await bot.telegram.getChatMember(ctx.chat.id, from.id);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
}

bot.command('subscribe', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('Run /subscribe inside a group where you are an admin.');
    return;
  }
  if (!(await callerIsGroupAdmin(ctx))) {
    await ctx.reply('🚫 Only group admins can subscribe a group to Pantheon signals.');
    return;
  }
  const chatTitle = 'title' in ctx.chat ? ctx.chat.title : null;
  await addGroupSubscription({
    chatId: ctx.chat.id,
    chatTitle: chatTitle ?? null,
    subscribedByTelegramId: ctx.from!.id,
    subscribedByUsername: ctx.from!.username ?? null,
  });
  await ctx.reply(
    '𓂀 <b>This group is now subscribed to Pantheon Calls.</b>\n\nApproved /callnow signals will be broadcast here. Run /unsubscribe to stop.',
    { parse_mode: 'HTML' },
  );
});

bot.command('unsubscribe', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('Run /unsubscribe inside a subscribed group.');
    return;
  }
  if (!(await callerIsGroupAdmin(ctx))) {
    await ctx.reply('🚫 Only group admins can unsubscribe.');
    return;
  }
  await removeGroupSubscription(ctx.chat.id);
  await ctx.reply('🔕 Pantheon signals will no longer be broadcast here.');
});

bot.command('optout', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Run /optout in a DM with the Oracle.');
    return;
  }
  await setDmOptOut(from.id, true);
  await ctx.reply(
    '🔕 <b>You will no longer receive Pantheon broadcasts in DM.</b>\n\nRun /optin to re-enable.',
    { parse_mode: 'HTML' },
  );
});

bot.command('optin', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Run /optin in a DM with the Oracle.');
    return;
  }
  await setDmOptOut(from.id, false);
  await ctx.reply('🔔 <b>Pantheon broadcasts re-enabled.</b>', { parse_mode: 'HTML' });
});

// Auto-track every group/supergroup/channel the bot joins, so approved calls
// broadcast to all of them without anyone running /subscribe.
bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  if (!update) return;
  const chat = update.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup' && chat.type !== 'channel') return;

  const status = update.new_chat_member.status;
  const isMember = status === 'creator' || status === 'administrator' || status === 'member';
  const isGone = status === 'left' || status === 'kicked';

  try {
    if (isMember) {
      await upsertGroupMembership({
        chatId: chat.id,
        chatTitle: 'title' in chat ? chat.title ?? null : null,
        chatType: chat.type,
      });
    } else if (isGone) {
      await markGroupLeft(chat.id);
    }
  } catch (err) {
    console.warn('[my_chat_member] track failed', err);
  }
});

bot.command('status', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply(
      '𓂀 <b>Status</b>\n\nThis is a DM. Use /premium to see your access.',
      { parse_mode: 'HTML' },
    );
    return;
  }
  const subscribed = await isGroupSubscribed(ctx.chat.id).catch(() => false);
  await ctx.reply(
    subscribed
      ? '𓂀 This group is <b>subscribed</b> to Pantheon Calls.'
      : '🔕 This group is <b>not subscribed</b>. Admins can run /subscribe to opt in.',
    { parse_mode: 'HTML' },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin approval callbacks (cn:ap:N / cn:rj:N)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort broadcast helper. Telegram error codes we care about:
 *   403 — user/chat blocked the bot. Skip silently.
 *   429 — rate limit. Honor `retry_after` from Telegram's response.
 *   400 — chat not found / banned. Skip silently.
 * Anything else: log warning and continue.
 *
 * Returns true when delivery succeeded, false otherwise. Callers use the false
 * signal to garbage-collect dead chats from the active broadcast list.
 */
async function sendBroadcast(chatId: number, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        // @ts-expect-error - Telegraf types may lag behind API
        disable_web_page_preview: true,
      });
      return true;
    } catch (err) {
      const e = err as { code?: number; response?: { parameters?: { retry_after?: number } } };
      if (e.code === 403 || e.code === 400) return false;
      if (e.code === 429) {
        const retry = e.response?.parameters?.retry_after ?? 1;
        await new Promise((r) => setTimeout(r, Math.min(retry, 30) * 1000));
        continue;
      }
      console.warn(`[broadcast] ${chatId} failed`, err);
      return false;
    }
  }
  return false;
}

async function broadcastApprovedCall(call: Awaited<ReturnType<typeof createApprovedCall>>): Promise<void> {
  const text = formatCallAlert(call);

  // Every group/supergroup/channel the bot is currently in (auto-tracked via
  // my_chat_member). 3.1s/msg pacing per-chat avoids Telegram's 20/min cap.
  const groupIds = await listActiveGroupIds().catch(() => [] as number[]);
  for (const chatId of groupIds) {
    const ok = await sendBroadcast(chatId, text);
    if (!ok) await markGroupLeft(chatId).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 3100));
  }

  // DM subscribers — 30/sec global Telegram cap, throttle ~25/sec.
  const dmTargets = await listOptedInDmTargets(5000).catch(() => [] as number[]);
  for (const userId of dmTargets) {
    await sendBroadcast(userId, text);
    await new Promise((r) => setTimeout(r, 40));
  }
}

bot.on('callback_query', async (ctx, next) => {
  const cq = ctx.callbackQuery;
  if (!cq || !('data' in cq) || !cq.data) return next();
  const data = cq.data;
  const from = ctx.from;
  if (!from) return next();

  const match = data.match(/^cn:(ap|rj):(\d+)$/);
  if (!match) return next();

  await ctx.answerCbQuery();

  if (!isAdmin(from.id)) {
    await ctx.answerCbQuery('🚫 Not an admin', { show_alert: true }).catch(() => undefined);
    return;
  }

  const action = match[1];
  const submissionId = parseInt(match[2], 10);

  const submission = await getSubmission(submissionId);
  if (!submission) {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => undefined);
    await ctx.reply(`Submission #${submissionId} not found.`);
    return;
  }
  if (submission.status !== 'pending') {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => undefined);
    await ctx.reply(`Submission #${submissionId} already <b>${submission.status}</b>.`, { parse_mode: 'HTML' });
    return;
  }

  if (action === 'rj') {
    const updated = await markSubmissionReviewed({
      id: submissionId,
      status: 'rejected',
      reviewerTelegramId: from.id,
    });
    if (!updated) {
      await ctx.reply(`Submission #${submissionId} could not be updated (race).`);
      return;
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => undefined);
    await ctx.reply(`❌ Submission #${submissionId} rejected.`);
    try {
      await bot.telegram.sendMessage(
        submission.caller_telegram_id,
        `❌ <b>Your call was not approved.</b>\nToken: <b>$${submission.ticker?.toUpperCase() ?? '?'}</b>\n<i>Try again with a different signal.</i>`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      console.warn('[approve] could not notify caller', err);
    }
    return;
  }

  // Approve path: re-snapshot DexScreener for fresh FDV right at broadcast time.
  await ctx.reply(`✅ Approving submission #${submissionId}…`);
  const fresh = await fetchDexScreenerSnapshot(submission.contract_address);

  const updated = await markSubmissionReviewed({
    id: submissionId,
    status: 'approved',
    reviewerTelegramId: from.id,
  });
  if (!updated) {
    await ctx.reply(`Submission #${submissionId} could not be updated (race).`);
    return;
  }

  let approvedCall;
  try {
    approvedCall = await createApprovedCall({
      submissionId,
      callerTelegramId: submission.caller_telegram_id,
      callerUsername: submission.caller_username,
      callerFirstName: submission.caller_first_name,
      contractAddress: submission.contract_address,
      chain: submission.chain,
      ticker: fresh?.symbol ?? submission.ticker,
      name: fresh?.name ?? submission.name,
      dexscreenerUrl: fresh?.url ?? null,
      thesis: submission.thesis,
      fdvAtCall: fresh?.fdvUsd ?? submission.fdv_at_submit,
      mcapAtCall: fresh?.mcapUsd ?? null,
      liquidityAtCall: fresh?.liquidityUsd ?? submission.liquidity_at_submit,
      priceUsdAtCall: fresh?.priceUsd ?? null,
    });
  } catch (err) {
    console.error('[approve] createApprovedCall failed', err);
    await ctx.reply('⚠️ Approval recorded but could not save the approved call. Check logs.');
    return;
  }

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => undefined);
  await ctx.reply(`📡 Broadcasting #${submissionId} now…`);

  try {
    await bot.telegram.sendMessage(
      submission.caller_telegram_id,
      `✅ <b>Your call on $${(approvedCall.ticker ?? '?').toUpperCase()} was approved.</b>\n\n<i>Broadcast in progress. Track it with /gods 7d.</i>`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    console.warn('[approve] could not notify caller', err);
  }

  // Run broadcast in background; the callback handler is already inside
  // waitUntil, so we just await directly — Vercel keeps the lambda alive.
  await broadcastApprovedCall(approvedCall);
});

// ─────────────────────────────────────────────────────────────────────────────
// CA card refresh callback (cc:rf:[<chain>:]0x…) — re-fetch DexScreener, edit
// in place. Tagless data is a legacy Base card; "rh:" marks Robinhood.
// ─────────────────────────────────────────────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  const cq = ctx.callbackQuery;
  if (!cq || !('data' in cq) || !cq.data) return;
  const from = ctx.from;
  const match = cq.data.match(/^cc:rf:(?:([a-z]{1,4}):)?(0x[a-f0-9]{40})$/);
  if (!match || !from) {
    await ctx.answerCbQuery().catch(() => undefined);
    return;
  }
  const chain = chainByRefreshTag(match[1]);
  const ca = match[2];

  // Each tap costs a DexScreener fetch + a message edit — cap per-user volume.
  const { allowed } = await checkRateLimit(from.id, 'ccrefresh', 60, 6).catch(() => ({ allowed: true }));
  if (!allowed) {
    await ctx.answerCbQuery('⏳ Easy — refresh again in a minute.').catch(() => undefined);
    return;
  }

  // Prefer this chat's own call (preserves the original caller line); fall
  // back to the earliest call anywhere so the button still works after a
  // forward into another chat.
  const chatId = cq.message?.chat.id;
  let call = chatId !== undefined ? await getTokenCall(chatId, ca).catch(() => null) : null;
  if (!call) call = await getEarliestTokenCall(ca).catch(() => null);
  const snap = await fetchTokenSnapshot(ca, [chain])
    .then((r) => r?.snapshot ?? null)
    .catch(() => null);
  if (!call || !snap) {
    await ctx.answerCbQuery('⚠️ Could not fetch fresh data — try again shortly.').catch(() => undefined);
    return;
  }

  // Same opportunistic ATH raise as the original card path.
  if (snap.fdvUsd !== null && snap.fdvUsd > (call.ath_fdv ?? 0)) {
    await raiseTokenCallAthByCa({
      contractAddress: ca,
      newAthFdv: snap.fdvUsd,
      newAthPriceUsd: snap.priceUsd,
    }).catch(() => undefined);
    call = { ...call, ath_fdv: snap.fdvUsd, ath_price_usd: snap.priceUsd };
  }

  try {
    await ctx.editMessageText(formatCaCard({ snapshot: snap, call, isNewCall: false, chain }), {
      parse_mode: 'HTML',
      reply_markup: caCardKeyboard(ctx, ca, chain),
      // @ts-expect-error - Telegraf types may lag behind API
      disable_web_page_preview: true,
    });
    await ctx.answerCbQuery('🔄 Card updated').catch(() => undefined);
  } catch (err) {
    // Telegram rejects no-op edits with 400 "message is not modified".
    const desc =
      (err as { description?: string })?.description ??
      (err instanceof Error ? err.message : String(err));
    if (desc.includes('message is not modified')) {
      await ctx.answerCbQuery('✓ Already up to date').catch(() => undefined);
    } else {
      console.warn('[cacard] refresh edit failed', err);
      await ctx.answerCbQuery('⚠️ Could not update the card.').catch(() => undefined);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /cancel — abort any active wizard
// ─────────────────────────────────────────────────────────────────────────────

bot.command('cancel', async (ctx) => {
  const from = ctx.from;
  if (!from || ctx.chat?.type !== 'private') return;
  let cancelled = false;
  const callPending = await getPendingCall(from.id).catch(() => null);
  if (callPending) {
    await clearPendingCall(from.id).catch(() => undefined);
    cancelled = true;
  }
  const oraclePending = await getPendingOracle(from.id).catch(() => false);
  if (oraclePending) {
    await clearPendingOracle(from.id).catch(() => undefined);
    cancelled = true;
  }
  await ctx.reply(cancelled ? '🛑 Cancelled.' : 'Nothing to cancel.');
});

// ─────────────────────────────────────────────────────────────────────────────
// Plain-text router for stateful flows (oracle CA + callnow wizard)
// ─────────────────────────────────────────────────────────────────────────────

bot.on('text', async (ctx, next) => {
  const from = ctx.from;
  if (!from || !ctx.chat) return next();
  if (ctx.chat.type !== 'private') return next();

  const msg = ctx.message;
  const text = msg && 'text' in msg ? msg.text.trim() : '';
  if (!text || text.startsWith('/')) return next();

  // 1. Active /callnow wizard? Route by step.
  const pendingCall = await getPendingCall(from.id).catch(() => null);
  if (pendingCall) {
    if (!(await ensurePremiumActive(ctx))) {
      await clearPendingCall(from.id).catch(() => undefined);
      return;
    }
    if (pendingCall.step === 'awaiting_ca') {
      await handleCallWizardCa(ctx, text);
      return;
    }
    if (pendingCall.step === 'awaiting_thesis') {
      await handleCallWizardThesis(ctx, pendingCall, text);
      return;
    }
  }

  // 2. Active /oracle pending state? Treat the message as the CA.
  const pendingOracle = await getPendingOracle(from.id).catch(() => false);
  if (pendingOracle) {
    const candidate = text.split(/\s+/)[0];
    if (!isValidEvmAddress(candidate)) {
      await ctx.reply(
        '❓ That doesn\'t look like a contract address. Send a 0x-prefixed 40-character hex string, or run /oracle again to cancel.',
      );
      return;
    }
    if (!(await ensurePremiumActive(ctx))) {
      await clearPendingOracle(from.id).catch(() => undefined);
      return;
    }
    await clearPendingOracle(from.id).catch(() => undefined);
    await runOracleRevelation(ctx, candidate);
    return;
  }

  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// CA auto-detection (RickBot-style card) — groups and bot DMs
// ─────────────────────────────────────────────────────────────────────────────

// Word-bounded so 64-char tx hashes don't half-match as a 40-char address.
const CA_MENTION_REGEX = /\b(0x[a-fA-F0-9]{40})\b/;
const CA_AUTOCALL_ENABLED = (process.env.CA_AUTOCALL_ENABLED ?? 'true').toLowerCase() !== 'false';
const CA_CARD_COOLDOWN_SECONDS = parseInt(process.env.CA_CARD_COOLDOWN_SECONDS || '1800', 10);
const CA_CARDS_PER_MIN_PER_CHAT = parseInt(process.env.CA_CARDS_PER_MIN_PER_CHAT || '4', 10);

/**
 * Inline keyboard under every CA card. "Call Now" deep-links into the bot DM
 * and auto-starts the /callnow wizard; "Refresh" re-fetches DexScreener and
 * edits the card in place. The chain's refreshTag rides in the callback data
 * so the refreshed card keeps its network — Base keeps the legacy tagless
 * form (cc:rf:<ca>, 6 + 42 chars) so buttons on older cards still work;
 * tagged chains (cc:rf:rh:<ca>, 9 + 42 chars) stay under Telegram's 64-byte
 * callback_data cap.
 */
function caCardKeyboard(ctx: Context, ca: string, chain: ChainInfo = BASE_CHAIN) {
  const botUsername = ctx.botInfo?.username ?? 'TransmuteOracle_bot';
  const tag = chain.refreshTag ? `${chain.refreshTag}:` : '';
  return {
    inline_keyboard: [
      [
        { text: '🚀 Call Now', url: `https://t.me/${botUsername}?start=callnow` },
        { text: '🔄 Refresh', callback_data: `cc:rf:${tag}${ca.toLowerCase()}` },
      ],
    ],
  };
}

async function replyWithCaCard(
  ctx: Context,
  ca: string,
  chains: ChainInfo | ChainInfo[] = BASE_CHAIN,
): Promise<'sent' | 'not_found' | 'skipped'> {
  // Priority-ordered: the first listed chain with a live pair claims the card.
  const allowedChains = Array.isArray(chains) ? chains : [chains];
  const chat = ctx.chat;
  const from = ctx.from;
  const msg = ctx.message;
  if (!chat || !from || !msg) return 'skipped';

  // Anti-spam layer 1: per-(chat, ca) cooldown. Re-pastes inside the window
  // are ignored silently — the group already has the card.
  const existing = await getTokenCall(chat.id, ca).catch(() => null);
  if (
    existing?.last_card_at &&
    Date.now() - new Date(existing.last_card_at).getTime() < CA_CARD_COOLDOWN_SECONDS * 1000
  ) {
    return 'skipped';
  }

  // Anti-spam layer 2: per-chat flood cap, distinct CAs included. The chat id
  // occupies the telegram_id column of the shared rate-limit bucket table.
  const { allowed } = await checkRateLimit(chat.id, 'cacard', 60, CA_CARDS_PER_MIN_PER_CHAT);
  if (!allowed) return 'skipped';

  // Ground truth before replying. Unknown token, or its best pair sits on a
  // network we don't cover → no card; a group bot that answers every random
  // hex string is noise (the explicit CÁ command surfaces this outcome to
  // the user, the auto-detector stays silent).
  const resolved = await fetchTokenSnapshot(ca, allowedChains);
  const snap = resolved?.snapshot;
  const chain = resolved?.chain;
  if (!snap || !chain) return 'not_found';

  let call = existing;
  let isNew = false;
  if (!call) {
    const recorded = await recordTokenCall({
      chatId: chat.id,
      chatTitle: 'title' in chat ? chat.title ?? null : null,
      contractAddress: ca,
      chain: chain.key,
      ticker: snap.symbol,
      name: snap.name,
      dexscreenerUrl: snap.url,
      callerTelegramId: from.id,
      callerUsername: from.username ?? null,
      callerFirstName: from.first_name ?? null,
      fdvAtCall: snap.fdvUsd,
      priceUsdAtCall: snap.priceUsd,
      liquidityAtCall: snap.liquidityUsd,
    });
    if (!recorded) return 'skipped';
    call = recorded.call;
    isNew = recorded.isNew;
  }

  // Live FDV above the stored peak → raise it now instead of waiting on cron.
  if (snap.fdvUsd !== null && snap.fdvUsd > (call.ath_fdv ?? 0)) {
    await raiseTokenCallAthByCa({
      contractAddress: ca,
      newAthFdv: snap.fdvUsd,
      newAthPriceUsd: snap.priceUsd,
    }).catch(() => undefined);
    call = { ...call, ath_fdv: snap.fdvUsd, ath_price_usd: snap.priceUsd };
  }

  await ctx.reply(formatCaCard({ snapshot: snap, call, isNewCall: isNew, chain }), {
    parse_mode: 'HTML',
    reply_parameters: { message_id: msg.message_id },
    reply_markup: caCardKeyboard(ctx, ca, chain),
    // @ts-expect-error - Telegraf types may lag behind API
    disable_web_page_preview: true,
  });
  await markTokenCallCardSent(call.id).catch(() => undefined);
  return 'sent';
}

// ─────────────────────────────────────────────────────────────────────────────
// "CÁ" command — Robinhood-chain CA card (groups and bot DMs)
// ─────────────────────────────────────────────────────────────────────────────

// The word "CÁ" (accent required, any case) routes the same card pipeline to
// the Robinhood chain: `CÁ 0x…` inline, or a bare `CÁ` replying to a message
// that contains the address. Registered before the bare-address auto-detector
// so `CÁ 0x…` is consumed here and never falls through to the Base card.
bot.on('text', async (ctx, next) => {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!CA_AUTOCALL_ENABLED || !chat || !from) return next();
  if (chat.type !== 'group' && chat.type !== 'supergroup' && chat.type !== 'private') {
    return next();
  }
  if (from.is_bot) return;

  const msg = ctx.message;
  if (!msg || !('text' in msg)) return next();
  // NFC so "CÁ" typed as A + combining acute still matches.
  const text = msg.text.normalize('NFC').trim();
  const lower = text.toLowerCase();
  if (lower !== 'cá' && !lower.startsWith('cá ')) return next();

  // Inline form first; a bare "CÁ" falls back to the replied-to message.
  let match = text.match(CA_MENTION_REGEX);
  if (!match && lower === 'cá') {
    const replied = 'reply_to_message' in msg ? msg.reply_to_message : undefined;
    const repliedText =
      replied && 'text' in replied && replied.text
        ? replied.text
        : replied && 'caption' in replied && replied.caption
          ? replied.caption
          : '';
    match = repliedText.match(CA_MENTION_REGEX);
  }

  try {
    if (!match) {
      // Explicit command with no address → usage hint, tightly capped per
      // chat so casual "cá" chatter can't turn the bot into a spam source.
      const { allowed } = await checkRateLimit(chat.id, 'cahint', 60, 2).catch(() => ({
        allowed: false,
      }));
      if (allowed) {
        await ctx.reply(
          `${ROBINHOOD_CHAIN.emoji} <b>CÁ — Robinhood chain card</b>\n\nSend <code>CÁ 0xContractAddress</code>, or reply <code>CÁ</code> to a message that contains the address.`,
          { parse_mode: 'HTML', reply_parameters: { message_id: msg.message_id } },
        );
      }
      return;
    }
    const outcome = await replyWithCaCard(ctx, match[1].toLowerCase(), ROBINHOOD_CHAIN);
    if (outcome === 'not_found') {
      await ctx.reply(
        '👁️ No Robinhood-chain pair found for that address on DexScreener or GeckoTerminal.',
        { reply_parameters: { message_id: msg.message_id } },
      );
    }
  } catch (err) {
    // Same contract as the auto-card: never break group message processing.
    console.warn('[cacard] robinhood card failed', err);
  }
});

bot.on('text', async (ctx, next) => {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!CA_AUTOCALL_ENABLED || !chat || !from) return next();
  // DMs are included: the stateful-flow router above runs first, so a CA
  // pasted mid-wizard (/callnow, /oracle) is consumed there and never
  // reaches this handler.
  if (chat.type !== 'group' && chat.type !== 'supergroup' && chat.type !== 'private') {
    return next();
  }
  if (from.is_bot) return;

  const msg = ctx.message;
  const text = msg && 'text' in msg ? msg.text : '';
  if (!text || text.startsWith('/')) return next();

  const match = text.match(CA_MENTION_REGEX);
  if (!match) return next();

  try {
    // Bare pastes auto-detect the network: Base wins when the CA trades on
    // both; the CÁ command above forces Robinhood for those collisions.
    await replyWithCaCard(ctx, match[1].toLowerCase(), SUPPORTED_CHAINS);
  } catch (err) {
    // The auto-card must never break group message processing.
    console.warn('[cacard] failed', err);
  }
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Transmute Oracle Bot is alive' });
  }

  // SECURITY (H6 / CWE-306): reject forged webhook POSTs. Telegram echoes the
  // secret token registered via setWebhook in this header. Enforced only when
  // TELEGRAM_WEBHOOK_SECRET is configured, so the bot keeps working during the
  // rollout window — set the env in this project AND re-run /api/set-webhook to
  // activate. Once set, knowing the webhook URL is no longer enough to inject
  // updates / impersonate users or admins.
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    const ok =
      typeof got === 'string' &&
      got.length === webhookSecret.length &&
      timingSafeEqual(Buffer.from(got), Buffer.from(webhookSecret));
    if (!ok) {
      return res.status(401).json({ ok: false });
    }
  } else {
    console.warn('[webhook] TELEGRAM_WEBHOOK_SECRET not set — webhook POSTs are NOT authenticated.');
  }

  // Long-running commands like /invoke take 1-3 min, but Telegram times out
  // webhooks at ~60s and retries on timeout (up to ~25x). waitUntil tells
  // Vercel to keep the Lambda alive past res.end() until the promise settles
  // (bounded by maxDuration=300s), so we can ACK Telegram now and still run
  // the oracle in the background without triggering duplicate deliveries.
  const updateId = (req.body as { update_id?: number } | undefined)?.update_id;

  waitUntil(
    (async () => {
      if (typeof updateId === 'number' && !(await claimTelegramUpdate(updateId))) {
        console.warn('[webhook] duplicate update_id suppressed:', updateId);
        return;
      }
      try {
        await bot.handleUpdate(req.body);
      } catch (err) {
        console.error('[webhook] Error handling update:', err);
      }
    })(),
  );

  res.status(200).json({ ok: true });
}
