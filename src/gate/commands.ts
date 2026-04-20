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
  findAccessCodeByHash,
  consumeAccessCode,
  saveWalletLinkFromCode,
} from './db';
import { getTokenBalance, formatTokenAmount } from './blockchain';
import { hashCode, maskCode, normalizeCode } from './codes';

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

async function redeemAccessCode(ctx: Context, raw: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const { allowed } = await checkRateLimit(from.id, 'code_verify', 300, 5);
  if (!allowed) {
    await ctx.reply('⏳ Too many verification attempts. Try again in a few minutes.');
    return;
  }

  const code = normalizeCode(raw);
  if (!code) {
    await ctx.reply(
      '❌ <b>Invalid code format.</b>\n\nExpected: <code>/verify TXM-XXXX-XXXX</code>',
      { parse_mode: 'HTML' },
    );
    await logAccess({ telegramId: from.id, action: 'code_redeem', success: false, reason: 'invalid_format' });
    return;
  }

  const codeHash = hashCode(code);
  const row = await findAccessCodeByHash(codeHash);

  if (!row) {
    await logAccess({ telegramId: from.id, action: 'code_redeem', success: false, reason: 'not_found' });
    await ctx.reply('❌ <b>Code not found.</b>\n\nGenerate a new one in the Nous App.', { parse_mode: 'HTML' });
    return;
  }
  if (row.revoked_at) {
    await logAccess({
      telegramId: from.id,
      action: 'code_redeem',
      success: false,
      reason: 'revoked',
      walletAddress: row.wallet_address,
    });
    await ctx.reply('❌ <b>Code revoked.</b>\n\nA newer code was issued for this wallet.', { parse_mode: 'HTML' });
    return;
  }
  if (row.consumed_at) {
    await logAccess({
      telegramId: from.id,
      action: 'code_redeem',
      success: false,
      reason: 'already_used',
      walletAddress: row.wallet_address,
    });
    await ctx.reply('❌ <b>Code already used.</b>\n\nGenerate a new one in the Nous App.', { parse_mode: 'HTML' });
    return;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await logAccess({
      telegramId: from.id,
      action: 'code_redeem',
      success: false,
      reason: 'expired',
      walletAddress: row.wallet_address,
    });
    await ctx.reply('⏰ <b>Code expired.</b>\n\nCodes are valid for 7 days. Generate a new one.', { parse_mode: 'HTML' });
    return;
  }

  let balance: Awaited<ReturnType<typeof getTokenBalance>>;
  try {
    balance = await getTokenBalance(row.wallet_address, { bypassCache: true });
  } catch (err) {
    console.error('[code_redeem] RPC failed', err);
    await ctx.reply('⚠️ Unable to verify balance right now. Please try again in a moment.');
    return;
  }

  if (!balance.meetsMinimum) {
    await logAccess({
      telegramId: from.id,
      action: 'code_redeem',
      success: false,
      reason: 'balance_dropped',
      walletAddress: row.wallet_address,
      metadata: { balance: balance.raw.toString() },
    });
    await ctx.reply(
      `❌ <b>Wallet no longer holds the required balance.</b>\n\nCurrent: <b>${formatTokenAmount(balance.raw, balance.decimals)}</b> NOUS\nRequired: <b>${GATE_CONFIG.minBalance.toLocaleString('en-US')}</b> NOUS`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const consumed = await consumeAccessCode(codeHash, from.id);
  if (!consumed) {
    await logAccess({
      telegramId: from.id,
      action: 'code_redeem',
      success: false,
      reason: 'race_consumed',
      walletAddress: row.wallet_address,
    });
    await ctx.reply('❌ <b>Code was just used or revoked.</b>\n\nGenerate a new one in the Nous App.', {
      parse_mode: 'HTML',
    });
    return;
  }

  await saveWalletLinkFromCode({
    telegramId: from.id,
    walletAddress: row.wallet_address,
    chainId: GATE_CONFIG.chainId,
    balance: balance.raw,
    durationDays: GATE_CONFIG.sessionDurationDays,
    codeHash,
  });

  await logAccess({
    telegramId: from.id,
    action: 'code_redeem',
    success: true,
    walletAddress: row.wallet_address,
    metadata: { masked: maskCode(code), balance: balance.raw.toString() },
  });

  await ctx.reply(
    `✨ <b>Premium access unlocked.</b>\n\n` +
      `Wallet: <code>${maskAddress(row.wallet_address)}</code>\n` +
      `Balance: <b>${formatTokenAmount(balance.raw, balance.decimals)}</b> NOUS\n` +
      `Session: <b>${GATE_CONFIG.sessionDurationDays} days</b>\n\n` +
      `🔮 /invoke — hunt hidden microcaps (max 3/day, resets at 00:00 UTC)\n` +
      `📊 /pulse · 🌀 /myths · 💎 /pearls also available.\n\n` +
      `<i>Generate a new code anytime in the Nous App — it will replace this one.</i>`,
    { parse_mode: 'HTML' },
  );
}

export function registerGateCommands(bot: Telegraf): void {
  bot.command(['link', 'relink'], async (ctx) => {
    await sendLinkInvite(ctx);
  });

  bot.command(['verify', 'redeem'], async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const msg = ctx.message;
    const text = msg && 'text' in msg ? msg.text : '';
    const parts = text.trim().split(/\s+/).slice(1);
    const raw = parts.join(' ').trim();

    if (raw) {
      await redeemAccessCode(ctx, raw);
      return;
    }

    const link = await getWalletLink(from.id);

    if (!link) {
      await ctx.reply(
        'ℹ️ No wallet linked yet.\n\n' +
          '• Open the Nous App to generate a Telegram access code, then send <code>/verify CODE</code>\n' +
          '• Or run /link to use the signature flow directly.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (isLinkExpired(link)) {
      await ctx.reply(
        `⏰ <b>Verification expired.</b>\n\nWallet: <code>${maskAddress(link.wallet_address)}</code>\nGenerate a new code in the Nous App or run /relink.`,
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
            ? '<i>Premium commands unlocked.</i>'
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
    `🔮 /invoke (3/day) · 📊 /pulse · 🌀 /myths · 💎 /pearls\n\n` +
    `Two ways to verify:\n` +
    `• 🎟 Generate a weekly code in the Nous App, then send <code>/verify CODE</code>\n` +
    `• 🔗 Tap the button below to sign via browser (no gas, just an ownership signature).\n\n` +
    `⏱ Signature link expires in ${GATE_CONFIG.nonceTtlMinutes} minutes.`;

  await sendLinkInvite(ctx, { intro: header + body });
}

export function buildHelpMessage(): string {
  return (
    `<b>𓂀 Transmute Oracle — Commands</b>\n\n` +
    `<b>Access:</b>\n` +
    `🎟 /verify CODE — Redeem a code generated in the Nous App\n` +
    `🔗 /link — Open browser signature page (alternative)\n` +
    `🔁 /relink — Refresh after expiry\n` +
    `🔎 /verify — Check status & balance\n` +
    `✨ /premium — List premium commands\n` +
    `🗑 /unlink — Remove wallet\n\n` +
    `<b>Premium (requires ${GATE_CONFIG.minBalance.toLocaleString('en-US')} NOUS):</b>\n` +
    `🔮 /invoke — Hunt hidden microcaps (max 3/day, resets 00:00 UTC)\n` +
    `📊 /pulse — Market daily report\n` +
    `🌀 /myths — Narrative tracker\n` +
    `💎 /pearls — Daily wisdom\n\n` +
    `<i>Verification lasts ${GATE_CONFIG.sessionDurationDays} days.</i>`
  );
}
