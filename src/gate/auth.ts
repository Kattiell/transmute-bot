import { GATE_CONFIG } from './config';

export function buildSignMessage(nonce: string, telegramId: number): string {
  return [
    'Nous Oracle — Telegram Wallet Link',
    '',
    `Telegram ID: ${telegramId}`,
    `Nonce: ${nonce}`,
    `Chain: Base (${GATE_CONFIG.chainId})`,
    `Token: ${GATE_CONFIG.tokenAddress}`,
    `Minimum: ${GATE_CONFIG.minBalance.toString()}`,
    '',
    'By signing, you prove ownership of this wallet to unlock premium Oracle commands.',
    'This signature is free and does not authorize any transaction.',
  ].join('\n');
}

export function buildLinkUrl(nonce: string): string {
  return `${GATE_CONFIG.linkBaseUrl.replace(/\/$/, '')}/tg-link/${nonce}`;
}
