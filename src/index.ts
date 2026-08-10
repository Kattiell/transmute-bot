import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { invokeOracle, invokeOracleRobinhood, invokeOracleWithPrompt } from './grok';
import { parseOracleOutput } from './parser';
import { hardenProjects, hardenProjectsRobinhood } from './oracle-harden';
import { formatWhispersReport, formatGenericReport } from './formatter';
import { PULSE_PROMPT } from './prompts';
import { ROBINHOOD_CHAIN } from './chains';
import { isOracleV4Enabled, runRobinhoodScanV4 } from './oracle-v4';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(token);

// Track active invocations to prevent spam
const activeUsers = new Set<number>();

/** Escape HTML special chars for Telegram HTML parse mode. */
function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

I channel real-time on-chain intelligence from the Base chain — hidden microcaps, macro signals, and live market structure.

<b>Commands:</b>

🔮 /invoke — Hunt hidden microcaps
🪶 /invokeRH — Hunt hidden microcaps on Robinhood Chain
📊 /pulse — Market daily report (macro, sentiment, flows)

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

    // Harden: tool-resolve each CA (or abstain) before formatting — a model-
    // generated address is never sent to users (I1).
    const hardened = await hardenProjects(projects);
    const messages = formatWhispersReport(hardened);
    await sendMessages(ctx.chat.id, messages);
  } catch (err) {
    console.error('[invoke] Error:', err);
    await ctx.reply('❌ The Oracle encountered an error. Please try again later.');
  } finally {
    activeUsers.delete(userId);
  }
});

// /invokeRH — Hidden Microcaps on Robinhood Chain (regex: Telegraf string
// triggers are case-sensitive and users type /invokeRH as often as /invokerh)
bot.command(/^invokerh$/i, async (ctx) => {
  const userId = ctx.from.id;

  if (activeUsers.has(userId)) {
    return ctx.reply('⏳ Your previous invocation is still running. Please wait.');
  }

  activeUsers.add(userId);

  try {
    await ctx.reply('🪶 <b>Invoking the Oracle...</b>\n<i>Scanning Robinhood Chain for hidden microcaps. This may take 1-3 minutes.</i>', { parse_mode: 'HTML' });

    // Optional v4 multi-stage pipeline (ORACLE_V4=on): discovery →
    // deterministic filter → forensic gate → attribution → red team → synthesis.
    // Verification and CA hardening are built in, so its report is sent as-is.
    // Default path (below) is the v3 single-pass ORACLE_RH_PROMPT + hardening.
    if (isOracleV4Enabled()) {
      const report = await runRobinhoodScanV4();
      await sendMessages(ctx.chat.id, formatGenericReport('TRANSMUTE ORACLE v4 — ROBINHOOD SCAN', report));
      return;
    }

    const raw = await invokeOracleRobinhood();
    const projects = parseOracleOutput(raw);

    if (projects.length === 0) {
      await ctx.reply('𓂀 The Oracle found no verified signals at this time.\n\n<i>All candidates failed verification. The market rests — or hides its cards well.</i>', { parse_mode: 'HTML' });
      return;
    }

    // Harden against Robinhood Chain: tool-resolve each CA before formatting —
    // a model-generated address is never sent as-is (I1). Signals whose CA
    // failed triangulation are DROPPED from the report, not rendered with a
    // warning: an unverifiable CA is noise, and printed noise reads as a call.
    const hardened = await hardenProjectsRobinhood(projects);
    const kept = hardened.filter((h) => h.resolution.status !== 'abstained');
    const cut = hardened.filter((h) => h.resolution.status === 'abstained');
    if (cut.length) {
      console.warn('[invokerh] dropped unverified signals:', cut.map((c) => `${c.ticker}: ${c.resolution.reason}`));
    }

    if (kept.length === 0) {
      const reasons = cut
        .slice(0, 6)
        .map((c) => `• <b>${escHtml(c.ticker)}</b> — <i>${escHtml(c.resolution.reason ?? 'unverified')}</i>`)
        .join('\n');
      await ctx.reply(
        '𓂀 The Oracle surfaced candidates, but none survived CA verification.\n\n' +
          (reasons ? `${reasons}\n\n` : '') +
          '<i>Every address is cross-checked against live market APIs and the chain explorer before being shown. Unverifiable ≠ opportunity.</i>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const messages = formatWhispersReport(kept, { chain: ROBINHOOD_CHAIN, fdvCap: '$500K' });
    if (cut.length) {
      messages.push(
        `🗑 <b>Dropped at verification</b> (${cut.length})\n` +
          cut
            .slice(0, 6)
            .map((c) => `• <b>${escHtml(c.ticker)}</b> — <i>${escHtml(c.resolution.reason ?? 'unverified')}</i>`)
            .join('\n'),
      );
    }
    await sendMessages(ctx.chat.id, messages);
  } catch (err) {
    console.error('[invokerh] Error:', err);
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

// /help
bot.help((ctx) => {
  ctx.reply(
    `<b>𓂀 Transmute Oracle — Commands</b>

🔮 /invoke — Hunt hidden microcaps on Base
🪶 /invokeRH — Hunt hidden microcaps on Robinhood Chain
📊 /pulse — Market daily report
❓ /help — Show this message

<i>All invocations call the Oracle in real-time with web search enabled. Responses take 1-3 minutes.</i>`,
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
    { command: 'invoke', description: 'Hunt hidden microcaps' },
    { command: 'invokerh', description: 'Hunt hidden microcaps on Robinhood Chain' },
    { command: 'pulse',  description: 'Market daily report (macro, sentiment, flows)' },
  ]);

  await bot.telegram.setChatMenuButton({
    menuButton: { type: 'commands' },
  });

  console.log('𓂀 Transmute Oracle Bot is running');
});
