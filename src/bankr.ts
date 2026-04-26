/**
 * Lightweight client for the Bankr Token Launch API.
 *
 * Docs: https://docs.bankr.bot/token-launching/overview
 *
 * The wallet-level API key (bk_usr_...) authenticates as a specific Bankr
 * wallet. All token deploys go FROM that wallet (the bot operator's). Until
 * we support per-user keys, /forge is admin-only.
 *
 * Required envs:
 *   BANKR_API_KEY      — wallet-level token (Authorization: Bearer ...)
 * Optional:
 *   BANKR_API_BASE     — defaults to https://api.bankr.bot
 *   BANKR_FEE_RECIPIENT_WALLET — overrides default fee recipient (creator wallet)
 */

const DEFAULT_BASE = 'https://api.bankr.bot';
const REQUEST_TIMEOUT_MS = 60_000;

export interface DeployInput {
  tokenName: string;
  tokenSymbol: string;
  feeRecipientWallet?: string;
  imageUrl?: string;
}

export interface DeployResult {
  raw: Record<string, unknown>;
  tokenAddress?: string;
  transactionHash?: string;
}

export class BankrError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Bankr API error ${status}`);
    this.status = status;
    // Bankr response bodies should never include the auth header itself,
    // but scrub any obvious bearer-token shapes defensively before storing
    // / displaying so future changes can't accidentally leak the secret.
    this.body = body.replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer [REDACTED]');
  }
}

function apiBase(): string {
  return (process.env.BANKR_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function apiKey(): string {
  const key = process.env.BANKR_API_KEY;
  if (!key) throw new Error('BANKR_API_KEY not configured');
  return key;
}

function pickAddress(payload: Record<string, unknown>): string | undefined {
  const direct =
    (payload.tokenAddress as string | undefined) ??
    (payload.contractAddress as string | undefined) ??
    (payload.address as string | undefined);
  if (typeof direct === 'string') return direct;
  // Some Bankr responses nest under data/result/token
  for (const k of ['data', 'result', 'token']) {
    const nested = payload[k];
    if (nested && typeof nested === 'object') {
      const found = pickAddress(nested as Record<string, unknown>);
      if (found) return found;
    }
  }
  return undefined;
}

function pickTxHash(payload: Record<string, unknown>): string | undefined {
  const direct =
    (payload.transactionHash as string | undefined) ??
    (payload.txHash as string | undefined) ??
    (payload.tx_hash as string | undefined);
  if (typeof direct === 'string') return direct;
  for (const k of ['data', 'result', 'token']) {
    const nested = payload[k];
    if (nested && typeof nested === 'object') {
      const found = pickTxHash(nested as Record<string, unknown>);
      if (found) return found;
    }
  }
  return undefined;
}

export async function deployBankrToken(input: DeployInput): Promise<DeployResult> {
  const url = `${apiBase()}/token-launches/deploy`;
  const body: Record<string, unknown> = {
    tokenName: input.tokenName,
    tokenSymbol: input.tokenSymbol,
  };
  if (input.feeRecipientWallet) {
    body.feeRecipient = { type: 'wallet', value: input.feeRecipientWallet };
  } else if (process.env.BANKR_FEE_RECIPIENT_WALLET) {
    body.feeRecipient = { type: 'wallet', value: process.env.BANKR_FEE_RECIPIENT_WALLET };
  }
  if (input.imageUrl) body.imageUrl = input.imageUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BankrError(res.status, text);
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new BankrError(200, text, 'Bankr returned non-JSON success body');
    }
    return {
      raw: payload,
      tokenAddress: pickAddress(payload),
      transactionHash: pickTxHash(payload),
    };
  } finally {
    clearTimeout(timer);
  }
}

const TICKER_REGEX = /^[A-Z0-9]{2,10}$/;
const NAME_REGEX = /^[\p{L}\p{N}\s.\-_!?]{2,40}$/u;
const URL_REGEX = /^https?:\/\/[^\s]+$/i;

export function validateTokenName(s: string): { ok: boolean; reason?: string } {
  const t = s.trim();
  if (t.length < 2) return { ok: false, reason: 'Name too short (min 2 chars).' };
  if (t.length > 40) return { ok: false, reason: 'Name too long (max 40 chars).' };
  if (!NAME_REGEX.test(t)) return { ok: false, reason: 'Letters / numbers / spaces / .-_!? only.' };
  return { ok: true };
}

export function validateTokenSymbol(s: string): { ok: boolean; normalized?: string; reason?: string } {
  const t = s.trim().toUpperCase().replace(/^\$/, '');
  if (!TICKER_REGEX.test(t)) {
    return { ok: false, reason: 'Ticker must be 2-10 uppercase letters/digits.' };
  }
  return { ok: true, normalized: t };
}

export function validateImageUrl(s: string): { ok: boolean; reason?: string } {
  const t = s.trim();
  if (t.toLowerCase() === 'skip') return { ok: true };
  if (!URL_REGEX.test(t)) return { ok: false, reason: 'Send a valid http(s) URL or "skip".' };
  return { ok: true };
}
