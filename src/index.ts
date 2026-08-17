import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { invokeOracleWithPrompt } from './grok';
import { formatGenericReport } from './formatter';
import { PULSE_PROMPT } from './prompts';
import { getMiniAppUrl, miniAppKeyboard } from './miniapp';

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
    } catch {
      // If HTML parsing fails, send as plain text
      const plain = msg.replace(/<[^>]+>/g, '');
      await bot.telegram.sendMessage(chatId, plain);
    }
    // Small delay between messages to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }
}

// NOTE: /invoke and /invokeRH were REMOVED. The Oracle hunt is systemic — the
// admin runs one dual-chain sweep in the Transmute App and every holder
// receives the broadcast on their timeline. Holders read it in the Mini App
// (/app), not by paying for a private hunt from here.

// /start — the Mini App is the primary destination now, so it is the first
// thing the user is offered rather than a command list to memorise.
bot.start((ctx) => {
  const hasApp = !!getMiniAppUrl();

  const welcome = `<b>𓂀 TRANSMUTE ORACLE</b>

Welcome to the Oracle, seeker.

I channel real-time on-chain intelligence — hidden microcaps, macro signals, and live market structure.

${hasApp ? '<b>Tap below to open the Transmute App</b> right here inside Telegram: connect your wallet and read the Oracle\'s live signals across Base and Robinhood Chain.\n\n' : ''}<b>Commands:</b>

𓂀 /app — Open the Transmute App
❓ /help — Show all commands

━━━━━━━━━━━━━━━
<i>Signal before attention. Always DYOR - NFA.</i>`;

  ctx.reply(welcome, {
    parse_mode: 'HTML',
    reply_markup: miniAppKeyboard('𓂀 Open Transmute App', ctx.chat?.type),
  });
});

// /app — direct route to the Mini App for people who already know it exists.
bot.command('app', (ctx) => {
  const keyboard = miniAppKeyboard('𓂀 Open Transmute App', ctx.chat?.type);
  if (!keyboard) {
    ctx.reply(
      ctx.chat?.type === 'private'
        ? '⚠️ The Mini App is not configured yet. Try again shortly.'
        : 'ℹ️ Open the Mini App from a direct message with me — Telegram only allows it in private chats.',
    );
    return;
  }
  ctx.reply('𓂀 <b>Transmute App</b>\n\nConnect your wallet and read the Oracle\'s live signals — without leaving Telegram.', {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
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

// /help
bot.help((ctx) => {
  ctx.reply(
    `<b>𓂀 Transmute Oracle — Commands</b>

𓂀 /app — Open the Transmute App inside Telegram
❓ /help — Show this message

<i>Oracle signals are broadcast systemically — open the app to read the live feed across Base and Robinhood Chain.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: miniAppKeyboard('𓂀 Open Transmute App', ctx.chat?.type),
    }
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
    { command: 'app',    description: 'Open the Transmute App' },
    { command: 'help',   description: 'Show all commands' },
  ]);

  // The composer's menu button stays the COMMANDS menu. Telegram gives that
  // slot to exactly one thing — the "/" list OR a web_app launcher, never both
  // — and taking the "/" list away hides every command from the user. The Mini
  // App is one tap away from /start and /app instead.
  await bot.telegram.setChatMenuButton({
    menuButton: { type: 'commands' },
  });

  console.log('𓂀 Transmute Oracle Bot is running');
});
