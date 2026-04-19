import type { Telegraf, Context } from 'telegraf';
import { GATE_CONFIG } from './config';
import { buildLinkUrl } from './auth';
import {
  createNonce,
  deleteWalletLink,
  getWalletLink,
  isLinkExpired,
  logAccess,
  checkRateLimit,
} from './db';
import { getTokenBalance, formatTokenAmount } from './blockchain';

function maskAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function humanizeTtl(isoUntil: string): string {
  const ms = new Date(isoUntil).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86400_000);
  const hours = Math.floor((ms % 86400_000) / 3600_000);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor(ms / 60_000);
  return `${hours}h ${minutes % 60}m`;
}

export async function sendLinkInvite(ctx: Context, opts: { intro?: string } = {}): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const { allowed } = await checkRateLimit(from.id, 'link', 3600, 5);
  if (!allowed) {
    await ctx.reply('⏳ Too many link attempts. Try again in an hour.');
    return;
  }

  try {
    const nonce = await createNonce(from.id);
    const url = buildLinkUrl(nonce);
    await logAccess({ telegramId: from.id, action: 'link_start', success: true });

    const intro =
      opts.intro ??
      `🔗 <b>Link your wallet</b>\n\nTap the button below to open the verification page in your browser. Connect a wallet holding at least <b>${GATE_CONFIG.minBalance.toLocaleString('en-US')} NOUS</b> on Base, sign the free off-chain message, and return to Telegram.\n\n<i>No gas, no transaction — just an ownership signature.</i>\n\n⏱ Link expires in ${GATE_CONFIG.nonceTtlMinutes} minutes.`;

    await ctx.reply(intro, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔐 Open verification page', url }]],
      },
    });
  } catch (err) {
    console.error('[sendLinkInvite]', err);
    await ctx.reply('❌ Could not start link flow. Please try again.');
  }
}

export function registerGateCommands(bot: Telegraf): void {
  bot.command(['link', 'relink'], async (ctx) => {
    await sendLinkInvite(ctx);
  });

  bot.command('verify', async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const link = await getWalletLink(from.id);

    if (!link) {
      await ctx.reply('ℹ️ No wallet linked yet. Run /link to begin.');
      return;
    }

    if (isLinkExpired(link)) {
      await ctx.reply(
        `⏰ <b>Verification expired.</b>\n\nWallet: <code>${maskAddress(link.wallet_address)}</code>\nRun /relink to verify again.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    try {
      const balance = await getTokenBalance(link.wallet_address);
      const status = balance.meetsMinimum ? '✅ ACTIVE' : '❌ BALANCE DROPPED';
      await ctx.reply(
        `<b>𓂀 Verification Status</b>\n\n` +
          `Status: <b>${status}</b>\n` +
          `Wallet: <code>${maskAddress(link.wallet_address)}</code>\n` +
          `Balance: <b>${formatTokenAmount(balance.raw, balance.decimals)}</b> NOUS\n` +
          `Required: ${GATE_CONFIG.minBalance.toLocaleString('en-US')} NOUS\n` +
          `Expires in: ${humanizeTtl(link.verified_until)}\n\n` +
          (balance.meetsMinimum
            ? '<i>All 4 premium commands unlocked.</i>'
            : '<i>Top up tokens or /relink a different wallet.</i>'),
        { parse_mode: 'HTML' }
      );
    } catch {
      await ctx.reply('⚠️ Could not fetch on-chain balance right now. Try again shortly.');
    }
  });

  bot.command('premium', async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const link = await getWalletLink(from.id);
    const unlocked = link && !isLinkExpired(link);

    const header = unlocked ? '✨ <b>Premium Access — Active</b>' : '🔒 <b>Premium Access — Locked</b>';
    const footer = unlocked
      ? 'All commands below are available.'
      : `Run /link to unlock — requires ${GATE_CONFIG.minBalance.toLocaleString('en-US')} NOUS on Base.`;

    await ctx.reply(
      `${header}\n\n` +
        `🔮 /invoke — Hunt hidden microcaps (Base)\n` +
        `📊 /pulse — Market daily report\n` +
        `🌀 /myths — Narrative tracker\n` +
        `💎 /pearls — Daily financial wisdom\n\n` +
        `<i>${footer}</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('unlink', async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    await deleteWalletLink(from.id);
    await logAccess({ telegramId: from.id, action: 'unlink', success: true });
    await ctx.reply('🗑 Wallet unlinked. Run /link anytime to connect again.');
  });
}

export async function handleStart(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const link = await getWalletLink(from.id);

  if (link && !isLinkExpired(link)) {
    try {
      const balance = await getTokenBalance(link.wallet_address);
      if (balance.meetsMinimum) {
        await ctx.reply(
          `<b>𓂀 TRANSMUTE ORACLE</b>\n\n` +
            `Welcome back, seeker.\n\n` +
            `✨ <b>Premium access active</b>\n` +
            `Wallet: <code>${maskAddress(link.wallet_address)}</code>\n` +
            `Balance: <b>${formatTokenAmount(balance.raw, balance.decimals)}</b> NOUS\n` +
            `Expires in: ${humanizeTtl(link.verified_until)}\n\n` +
            `<b>Channel the Oracle:</b>\n` +
            `🔮 /invoke — Hunt hidden microcaps\n` +
            `📊 /pulse — Market daily report\n` +
            `🌀 /myths — Narrative tracker\n` +
            `💎 /pearls — Daily wisdom\n\n` +
            `<i>/verify · /help · /unlink</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }
    } catch {
      // fall through to re-link flow if RPC fails
    }
  }

  const header =
    link && isLinkExpired(link)
      ? `<b>𓂀 TRANSMUTE ORACLE</b>\n\n⏰ Your verification expired — let's relink.\n\n`
      : `<b>𓂀 TRANSMUTE ORACLE</b>\n\nWelcome, seeker. I channel real-time on-chain intelligence on Base — hidden microcaps, macro signals, living narratives, esoteric teachings.\n\n`;

  const body =
    `<b>Access is token-gated.</b> Hold at least <b>${GATE_CONFIG.minBalance.toLocaleString('en-US')} NOUS</b> in a Base wallet to unlock:\n\n` +
    `🔮 /invoke · 📊 /pulse · 🌀 /myths · 💎 /pearls\n\n` +
    `Tap the button below to verify your wallet — no gas, just an ownership signature. Takes 30 seconds.\n\n` +
    `⏱ Link expires in ${GATE_CONFIG.nonceTtlMinutes} minutes.`;

  await sendLinkInvite(ctx, { intro: header + body });
}

export function buildHelpMessage(): string {
  return (
    `<b>𓂀 Transmute Oracle — Commands</b>\n\n` +
    `<b>Access:</b>\n` +
    `🔗 /link — Open browser verification page\n` +
    `🔁 /relink — Refresh after expiry\n` +
    `🔎 /verify — Check status & balance\n` +
    `✨ /premium — List premium commands\n` +
    `🗑 /unlink — Remove wallet\n\n` +
    `<b>Premium (requires ${GATE_CONFIG.minBalance.toLocaleString('en-US')} NOUS):</b>\n` +
    `🔮 /invoke — Hunt hidden microcaps\n` +
    `📊 /pulse — Market daily report\n` +
    `🌀 /myths — Narrative tracker\n` +
    `💎 /pearls — Daily wisdom\n\n` +
    `<i>Verification lasts ${GATE_CONFIG.sessionDurationDays} days.</i>`
  );
}
