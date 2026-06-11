export const GATE_CONFIG = {
  tokenAddress: (process.env.GATE_TOKEN_ADDRESS || '0x557E8f1cd9fB4e9dfEcA817b15B737328D90821A').toLowerCase() as `0x${string}`,
  minBalance: BigInt(process.env.GATE_MIN_BALANCE || '100000000'),
  chainId: parseInt(process.env.GATE_CHAIN_ID || '8453', 10),
  rpcUrls: [
    process.env.BASE_RPC_1 || 'https://mainnet.base.org',
    process.env.BASE_RPC_2 || 'https://base.llamarpc.com',
    process.env.BASE_RPC_3 || 'https://base-rpc.publicnode.com',
  ].filter(Boolean),
  linkBaseUrl: process.env.GATE_LINK_BASE_URL || 'https://transmute-app.vercel.app',
  sessionDurationDays: 7,
  nonceTtlMinutes: 10,
  cacheTtlSeconds: 60,
};

export const PREMIUM_COMMANDS = ['invoke', 'pulse', 'myths', 'pearls', 'oracle', 'callnow'] as const;
export type PremiumCommand = (typeof PREMIUM_COMMANDS)[number];

export const DAILY_LIMITS: Partial<Record<PremiumCommand, number>> = {
  invoke: parseInt(process.env.GATE_INVOKE_DAILY_LIMIT || '7', 10),
  oracle: parseInt(process.env.GATE_ORACLE_DAILY_LIMIT || '5', 10),
  callnow: parseInt(process.env.GATE_CALLNOW_DAILY_LIMIT || '3', 10),
};

/** Telegram user IDs allowed to approve/reject calls. Comma-separated env var. */
export function getAdminTelegramIds(): number[] {
  const raw = process.env.ADMIN_TELEGRAM_IDS || '';
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function isAdmin(telegramId: number | undefined | null): boolean {
  if (!telegramId) return false;
  return getAdminTelegramIds().includes(telegramId);
}

/**
 * God-mode wallet allowlist. Wallets here bypass the $TRANSMUTE balance gate
 * (premium commands + code redeem) AND every premium daily limit (/invoke,
 * /oracle, ...). Mirrored in `nous-app/src/lib/gate-exempt.ts`, which applies the
 * same list to the site + arena gates. Keep both in sync.
 *
 * Source of truth: GATE_EXEMPT_WALLETS env (comma-separated, any case). Defaults
 * are public on-chain addresses, so hardcoding them is safe. Privilege grant, not
 * a security boundary — keep the list short.
 */
const EXEMPT_WALLETS: ReadonlySet<string> = new Set(
  (process.env.GATE_EXEMPT_WALLETS ||
    '0xcd7932b2ed451a319d1a3e8b836c343c83bc063d,0xf9a5391c9e36b39171fdbe8210269828acea6927')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
);

/** True when `wallet` is on the god-mode allowlist (case-insensitive). */
export function isExemptWallet(wallet?: string | null): boolean {
  if (!wallet) return false;
  return EXEMPT_WALLETS.has(wallet.toLowerCase());
}
