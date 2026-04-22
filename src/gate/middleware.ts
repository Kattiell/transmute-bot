import type { Context, MiddlewareFn } from 'telegraf';
import { GATE_CONFIG, PREMIUM_COMMANDS } from './config';
import { getWalletLink, isLinkExpired, logAccess, upsertTelegramUser, checkRateLimit } from './db';
import { getTokenBalance, formatTokenAmount } from './blockchain';

function extractCommand(text: string): string | null {
  const m = text.match(/^\/([a-z_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export const identityMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const from = ctx.from;
  if (from) {
    await upsertTelegramUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
      languageCode: from.language_code,
    });
  }
  return next();
};

export const globalRateLimitMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next();
  const { allowed } = await checkRateLimit(from.id, 'global', 60, 20);
  if (!allowed) {
    await ctx.reply('⏳ Too many requests. Take a breath — try again in a minute.');
    return;
  }
  return next();
};

export const premiumGateMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const msg = ctx.message;
  if (!msg || !('text' in msg) || !msg.text) return next();

  const cmd = extractCommand(msg.text);
  if (!cmd || !PREMIUM_COMMANDS.includes(cmd as (typeof PREMIUM_COMMANDS)[number])) {
    return next();
  }

  const from = ctx.from;
  if (!from) return;

  const { allowed } = await checkRateLimit(from.id, 'premium', 60, 5);
  if (!allowed) {
    await ctx.reply('⏳ Premium commands are rate-limited to 5 per minute. Please wait.');
    return;
  }

  const link = await getWalletLink(from.id);

  if (!link) {
    await logAccess({ telegramId: from.id, action: `cmd:${cmd}`, success: false, reason: 'no_link' });
    await ctx.reply(
      `🔒 <b>This is a premium command.</b>\n\nYou need to link a wallet holding at least <b>${GATE_CONFIG.minBalance.toLocaleString('en-US')} $TRANSMUTE</b> on Base.\n\nRun /link to begin.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (isLinkExpired(link)) {
    await logAccess({
      telegramId: from.id,
      action: `cmd:${cmd}`,
      success: false,
      reason: 'expired',
      walletAddress: link.wallet_address,
    });
    await ctx.reply(
      `⏰ <b>Your wallet verification expired.</b>\n\nFor security, verification lasts 7 days. Run /relink to verify again — takes 30 seconds.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  try {
    const balance = await getTokenBalance(link.wallet_address);
    if (!balance.meetsMinimum) {
      await logAccess({
        telegramId: from.id,
        action: `cmd:${cmd}`,
        success: false,
        reason: 'balance_dropped',
        walletAddress: link.wallet_address,
        metadata: { balance: balance.raw.toString() },
      });
      await ctx.reply(
        `❌ <b>Insufficient token balance.</b>\n\nCurrent: <b>${formatTokenAmount(balance.raw, balance.decimals)}</b> $TRANSMUTE\nRequired: <b>${GATE_CONFIG.minBalance.toLocaleString('en-US')}</b> $TRANSMUTE\n\nAcquire more tokens or /relink a different wallet.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
  } catch (err) {
    console.error('[gate] balance check failed', err);
    await ctx.reply('⚠️ Unable to verify balance right now. Please try again in a moment.');
    return;
  }

  await logAccess({
    telegramId: from.id,
    action: `cmd:${cmd}`,
    success: true,
    walletAddress: link.wallet_address,
  });
  return next();
};
