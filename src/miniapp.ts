import type { InlineKeyboardMarkup } from 'telegraf/types';

/**
 * Telegram Mini App entry point.
 *
 * The Mini App is a route inside the Transmute App (nous-app) — `/tma` — not a
 * separate frontend. That is deliberate: the wallet stack (RainbowKit + wagmi),
 * the iron-session and the $TRANSMUTE gate already live there, and duplicating
 * them in the bot would mean two WalletConnect projects, two session
 * implementations and two places to get security wrong.
 *
 * MUST be https:// — Telegram rejects `web_app` buttons on any other scheme,
 * and an http:// URL would also break the wallet connection (WebCrypto and
 * wallet deep links both require a secure context).
 */
const RAW_URL = (process.env.TELEGRAM_MINI_APP_URL || '').trim();

/**
 * The configured Mini App URL, or null when unset/invalid.
 *
 * Returning null rather than throwing keeps the bot fully functional without
 * the Mini App configured: every call site degrades to plain text instead of
 * crashing a command handler. An http:// or malformed value is treated as
 * unset and logged once at import — Telegram would reject the button anyway,
 * and a silent no-op is much harder to debug than a boot warning.
 */
export function getMiniAppUrl(): string | null {
  if (!RAW_URL) return null;
  try {
    const parsed = new URL(RAW_URL);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

if (RAW_URL && !getMiniAppUrl()) {
  console.warn('[miniapp] TELEGRAM_MINI_APP_URL is set but is not a valid https:// URL — Mini App buttons will be hidden.');
}

/**
 * Inline keyboard that opens the Mini App inside Telegram.
 *
 * `web_app` buttons are only valid in PRIVATE chats — Telegram rejects the
 * whole message if one appears in a group. Call sites pass the chat type and
 * get `undefined` where a button isn't allowed, so the reply still sends.
 *
 * @param label   Button caption.
 * @param chatType `ctx.chat?.type` — anything other than 'private' returns undefined.
 */
export function miniAppKeyboard(
  label = '𓂀 Open Transmute App',
  chatType?: string,
): InlineKeyboardMarkup | undefined {
  const url = getMiniAppUrl();
  if (!url) return undefined;
  if (chatType && chatType !== 'private') return undefined;
  return { inline_keyboard: [[{ text: label, web_app: { url } }]] };
}
