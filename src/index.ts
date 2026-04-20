import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { invokeOracle, invokeOracleWithPrompt } from './grok';
import { parseOracleOutput } from './parser';
import { formatWhispersReport, formatGenericReport } from './formatter';
import { PULSE_PROMPT, MYTHS_PROMPT, PEARLS_PROMPT } from './prompts';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(token);

// Track active invocations to prevent spam
const activeUsers = new Set<number>();

async function sendMessages(chatId: number, messages: string[]): Promise<void> {
  for (const msg of messages) {
    if (!msg.trim()) continue;
    try {
      await bot.telegram.sendMessage(chatId, msg, {
        parse_mode: 'HTML',
        // @ts-expect-error - Telegraf types may lag behind API
        disable_web_page_preview: true,
      });
    } catch (err) {
      // If HTML parsing fails, send as plain text
      const plain = msg.replace(/<[^>]+>/g, '');
      await bot.telegram.sendMessage(chatId, plain);
    }
    // Small delay between messages to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }
}

// /start
bot.start((ctx) => {
  const welcome = `<b>𓂀 TRANSMUTE ORACLE</b>

Welcome to the Oracle, seeker.

I channel real-time on-chain intelligence from the Base chain — hidden microcaps, macro signals, living narratives, and esoteric teachings.

<b>Commands:</b>

🔮 /invoke — Hunt hidden microcaps (&lt;$600K FDV)
📊 /pulse — Market daily report (macro, sentiment, flows)
🌀 /myths — Narrative tracker (rising stories)
💎 /pearls — Daily financial wisdom

<i>Each invocation calls the Oracle in real-time. Responses may take 1-3 minutes as it scans live data across chains and social layers.</i>

━━━━━━━━━━━━━━━
<i>Signal before attention. Always DYOR - NFA.</i>`;

  ctx.reply(welcome, { parse_mode: 'HTML' });
});

// /invoke — Hidden Microcaps
bot.command('invoke', async (ctx) => {
  const userId = ctx.from.id;

  if (activeUsers.has(userId)) {
    return ctx.reply('⏳ Your previous invocation is still running. Please wait.');
  }

  activeUsers.add(userId);

  try {
    await ctx.reply('🔮 <b>Invoking the Oracle...</b>\n<i>Scanning Base chain for hidden microcaps. This may take 1-3 minutes.</i>', { parse_mode: 'HTML' });

    const raw = await invokeOracle();
    const projects = parseOracleOutput(raw);

    if (projects.length === 0) {
      await ctx.reply('𓂀 The Oracle found no verified signals at this time.\n\n<i>All candidates failed verification. The market rests — or hides its cards well.</i>', { parse_mode: 'HTML' });
      return;
    }

    const messages = formatWhispersReport(projects);
    await sendMessages(ctx.chat.id, messages);
  } catch (err) {
    console.error('[invoke] Error:', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  } finally {
    activeUsers.delete(userId);
  }
});

// /pulse — Market Daily Report
bot.command('pulse', async (ctx) => {
  const userId = ctx.from.id;

  if (activeUsers.has(userId)) {
    return ctx.reply('⏳ Your previous invocation is still running. Please wait.');
  }

  activeUsers.add(userId);

  try {
    await ctx.reply('📊 <b>Channeling the Pulse...</b>\n<i>Aggregating macro, sentiment, and on-chain flows. 1-3 minutes.</i>', { parse_mode: 'HTML' });

    const raw = await invokeOracleWithPrompt(PULSE_PROMPT);
    const messages = formatGenericReport('MARKET DAILY REPORT', raw);
    await sendMessages(ctx.chat.id, messages);
  } catch (err) {
    console.error('[pulse] Error:', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  } finally {
    activeUsers.delete(userId);
  }
});

// /myths — Narrative Tracker
bot.command('myths', async (ctx) => {
  const userId = ctx.from.id;

  if (activeUsers.has(userId)) {
    return ctx.reply('⏳ Your previous invocation is still running. Please wait.');
  }

  activeUsers.add(userId);

  try {
    await ctx.reply('🌀 <b>Unveiling the Myths...</b>\n<i>Tracking living narratives across chains and social layers. 1-3 minutes.</i>', { parse_mode: 'HTML' });

    const raw = await invokeOracleWithPrompt(MYTHS_PROMPT);
    const messages = formatGenericReport('NARRATIVE TRACKER', raw);
    await sendMessages(ctx.chat.id, messages);
  } catch (err) {
    console.error('[myths] Error:', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  } finally {
    activeUsers.delete(userId);
  }
});

// /pearls — Daily Teaching
bot.command('pearls', async (ctx) => {
  const userId = ctx.from.id;

  if (activeUsers.has(userId)) {
    return ctx.reply('⏳ Your previous invocation is still running. Please wait.');
  }

  activeUsers.add(userId);

  try {
    await ctx.reply('💎 <b>Summoning a Pearl...</b>\n<i>The Oracle prepares a teaching. 1-2 minutes.</i>', { parse_mode: 'HTML' });

    const raw = await invokeOracleWithPrompt(PEARLS_PROMPT);
    const messages = formatGenericReport('PEARL OF KNOWLEDGE', raw);
    await sendMessages(ctx.chat.id, messages);
  } catch (err) {
    console.error('[pearls] Error:', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  } finally {
    activeUsers.delete(userId);
  }
});

// /help
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

// Unknown commands
bot.on('text', (ctx) => {
  if (ctx.message.text.startsWith('/')) {
    ctx.reply('Unknown command. Use /help to see available commands.');
  }
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Launch
bot.launch().then(async () => {
  await bot.telegram.setMyCommands([
    { command: 'start',  description: 'Start main menu' },
    { command: 'invoke', description: 'Hunt hidden microcaps (<$600K FDV)' },
    { command: 'pulse',  description: 'Market daily report (macro, sentiment, flows)' },
    { command: 'myths',  description: 'Narrative tracker (rising stories)' },
    { command: 'pearls', description: 'Daily financial wisdom' },
  ]);

  await bot.telegram.setChatMenuButton({
    menuButton: { type: 'commands' },
  });

  console.log('𓂀 Transmute Oracle Bot is running');
});
