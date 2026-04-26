export const GATE_CONFIG = {
  tokenAddress: (process.env.GATE_TOKEN_ADDRESS || '0x557E8f1cd9fB4e9dfEcA817b15B737328D90821A').toLowerCase() as `0x${string}`,
  minBalance: BigInt(process.env.GATE_MIN_BALANCE || '25000000'),
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
  invoke: parseInt(process.env.GATE_INVOKE_DAILY_LIMIT || '3', 10),
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
