import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Telegraf } from 'telegraf';
import { invokeOracle, invokeOracleWithPrompt } from '../src/grok';
import { parseOracleOutput } from '../src/parser';
import { formatWhispersReport, formatGenericReport } from '../src/formatter';
import { PULSE_PROMPT, MYTHS_PROMPT, PEARLS_PROMPT } from '../src/prompts';

const token = process.env.TELEGRAM_BOT_TOKEN!;
const bot = new Telegraf(token);

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

// Register commands
bot.start((ctx) => {
  ctx.reply(
    `<b>𓂀 TRANSMUTE ORACLE</b>

Welcome to the Oracle, seeker.

I channel real-time on-chain intelligence from the Base chain — hidden microcaps, macro signals, living narratives, and esoteric teachings.

<b>Commands:</b>

🔮 /invoke — Hunt hidden microcaps (&lt;$600K FDV)
📊 /pulse — Market daily report (macro, sentiment, flows)
🌀 /myths — Narrative tracker (rising stories)
💎 /pearls — Daily financial wisdom

<i>Each invocation calls the Oracle in real-time. Responses may take 1-3 minutes as it scans live data across chains and social layers.</i>

━━━━━━━━━━━━━━━
<i>Signal before attention. Always DYOR - NFA.</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('invoke', async (ctx) => {
  try {
    await ctx.reply('🔮 <b>Invoking the Oracle...</b>\n<i>Scanning Base chain for hidden microcaps. This may take 1-3 minutes.</i>', { parse_mode: 'HTML' });

    const raw = await invokeOracle();
    const projects = parseOracleOutput(raw);

    if (projects.length === 0) {
      await ctx.reply('𓂀 The Oracle found no verified signals at this time.\n\n<i>All candidates failed verification.</i>', { parse_mode: 'HTML' });
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

bot.help((ctx) => {
  ctx.reply(
    `<b>𓂀 Transmute Oracle — Commands</b>

🔮 /invoke — Hunt hidden microcaps on Base (&lt;$600K FDV)
📊 /pulse — Market daily report
🌀 /myths — Narrative tracker
💎 /pearls — Daily financial wisdom
❓ /help — Show this message

<i>All invocations call the Grok AI in real-time with web search enabled. Responses take 1-3 minutes.</i>`,
    { parse_mode: 'HTML' }
  );
});

// Vercel serverless handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Transmute Oracle Bot is alive' });
  }

  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    console.error('[webhook] Error handling update:', err);
  }

  // Always return 200 to Telegram (otherwise it retries)
  res.status(200).json({ ok: true });
}
