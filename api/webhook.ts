import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { Telegraf } from 'telegraf';
import { invokeOracle, invokeOracleWithPrompt } from '../src/grok';
import { parseOracleOutput } from '../src/parser';
import { formatWhispersReport, formatGenericReport } from '../src/formatter';
import { PULSE_PROMPT, MYTHS_PROMPT, PEARLS_PROMPT } from '../src/prompts';
import {
  identityMiddleware,
  globalRateLimitMiddleware,
  premiumGateMiddleware,
} from '../src/gate/middleware';
import { registerGateCommands, handleStart, buildHelpMessage } from '../src/gate/commands';
import { checkAndIncrementDailyUsage, claimTelegramUpdate, getWalletLink, logAccess } from '../src/gate/db';
import { DAILY_LIMITS } from '../src/gate/config';

const token = process.env.TELEGRAM_BOT_TOKEN!;
const bot = new Telegraf(token);

bot.use(identityMiddleware);
bot.use(globalRateLimitMiddleware);
bot.use(premiumGateMiddleware);

async function sendMessages(chatId: number, messages: string[]): Promise<void> {
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
    await new Promise((r) => setTimeout(r, 500));
  }
}

bot.start(async (ctx) => {
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

    const raw = await invokeOracle();
    const projects = parseOracleOutput(raw);

    if (projects.length === 0) {
      const messages = formatGenericReport('ORACLE SCAN REPORT', raw);
      await sendMessages(ctx.chat.id, messages);
      return;
    }

    await sendMessages(ctx.chat.id, formatWhispersReport(projects));
  } catch (err) {
    console.error('[invoke]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

bot.command('pulse', async (ctx) => {
  try {
    await ctx.reply('📊 <b>Channeling the Pulse...</b>\n<i>Aggregating macro, sentiment, and on-chain flows. 1-3 minutes.</i>', { parse_mode: 'HTML' });
    const raw = await invokeOracleWithPrompt(PULSE_PROMPT);
    await sendMessages(ctx.chat.id, formatGenericReport('MARKET DAILY REPORT', raw));
  } catch (err) {
    console.error('[pulse]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

bot.command('myths', async (ctx) => {
  try {
    await ctx.reply('🌀 <b>Unveiling the Myths...</b>\n<i>Tracking living narratives. 1-3 minutes.</i>', { parse_mode: 'HTML' });
    const raw = await invokeOracleWithPrompt(MYTHS_PROMPT);
    await sendMessages(ctx.chat.id, formatGenericReport('NARRATIVE TRACKER', raw));
  } catch (err) {
    console.error('[myths]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

bot.command('pearls', async (ctx) => {
  try {
    await ctx.reply('💎 <b>Summoning a Pearl...</b>\n<i>The Oracle prepares a teaching. 1-2 minutes.</i>', { parse_mode: 'HTML' });
    const raw = await invokeOracleWithPrompt(PEARLS_PROMPT);
    await sendMessages(ctx.chat.id, formatGenericReport('PEARL OF KNOWLEDGE', raw));
  } catch (err) {
    console.error('[pearls]', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  }
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Transmute Oracle Bot is alive' });
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
