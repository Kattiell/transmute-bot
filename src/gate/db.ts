import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { GATE_CONFIG } from './config';

let _client: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export interface TelegramUser {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  language_code: string | null;
  last_seen_at: string;
}

export interface WalletLink {
  telegram_id: number;
  wallet_address: string;
  chain_id: number;
  balance_at_verify: string;
  verified_at: string;
  verified_until: string;
  signature: string;
}

export async function upsertTelegramUser(u: {
  telegramId: number;
  username?: string;
  firstName?: string;
  languageCode?: string;
}): Promise<void> {
  await db()
    .from('telegram_users')
    .upsert(
      {
        telegram_id: u.telegramId,
        username: u.username ?? null,
        first_name: u.firstName ?? null,
        language_code: u.languageCode ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_id' }
    );
}

export async function getWalletLink(telegramId: number): Promise<WalletLink | null> {
  const { data } = await db()
    .from('telegram_wallet_links')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return (data as WalletLink) ?? null;
}

export function isLinkExpired(link: WalletLink): boolean {
  return new Date(link.verified_until).getTime() <= Date.now();
}

export async function saveWalletLink(input: {
  telegramId: number;
  walletAddress: string;
  chainId: number;
  balance: bigint;
  signature: string;
}): Promise<void> {
  const now = new Date();
  const until = new Date(now.getTime() + GATE_CONFIG.sessionDurationDays * 86400_000);
  await db()
    .from('telegram_wallet_links')
    .upsert(
      {
        telegram_id: input.telegramId,
        wallet_address: input.walletAddress.toLowerCase(),
        chain_id: input.chainId,
        balance_at_verify: input.balance.toString(),
        verified_at: now.toISOString(),
        verified_until: until.toISOString(),
        signature: input.signature,
      },
      { onConflict: 'telegram_id' }
    );
}

export async function deleteWalletLink(telegramId: number): Promise<void> {
  await db().from('telegram_wallet_links').delete().eq('telegram_id', telegramId);
}

export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

export async function createNonce(telegramId: number): Promise<string> {
  const nonce = generateNonce();
  const expires = new Date(Date.now() + GATE_CONFIG.nonceTtlMinutes * 60_000);
  await db().from('telegram_auth_nonces').insert({
    nonce,
    telegram_id: telegramId,
    expires_at: expires.toISOString(),
  });
  return nonce;
}

export interface NonceRow {
  nonce: string;
  telegram_id: number;
  wallet_address: string | null;
  consumed_at: string | null;
  expires_at: string;
}

export async function getNonce(nonce: string): Promise<NonceRow | null> {
  const { data } = await db().from('telegram_auth_nonces').select('*').eq('nonce', nonce).maybeSingle();
  return (data as NonceRow) ?? null;
}

export async function consumeNonce(nonce: string, walletAddress: string): Promise<boolean> {
  const { data, error } = await db()
    .from('telegram_auth_nonces')
    .update({ consumed_at: new Date().toISOString(), wallet_address: walletAddress.toLowerCase() })
    .eq('nonce', nonce)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select()
    .maybeSingle();
  return !error && !!data;
}

export async function readCachedBalance(
  wallet: string,
  chainId: number,
  token: string
): Promise<bigint | null> {
  const { data } = await db()
    .from('telegram_balance_cache')
    .select('balance, fetched_at')
    .eq('wallet_address', wallet.toLowerCase())
    .eq('chain_id', chainId)
    .eq('token_address', token.toLowerCase())
    .maybeSingle();
  if (!data) return null;
  const ageMs = Date.now() - new Date(data.fetched_at).getTime();
  if (ageMs > GATE_CONFIG.cacheTtlSeconds * 1000) return null;
  return BigInt(data.balance);
}

export async function writeCachedBalance(
  wallet: string,
  chainId: number,
  token: string,
  balance: bigint
): Promise<void> {
  await db()
    .from('telegram_balance_cache')
    .upsert(
      {
        wallet_address: wallet.toLowerCase(),
        chain_id: chainId,
        token_address: token.toLowerCase(),
        balance: balance.toString(),
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'wallet_address,chain_id,token_address' }
    );
}

export async function logAccess(input: {
  telegramId?: number;
  action: string;
  walletAddress?: string;
  success: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db().from('telegram_access_log').insert({
      telegram_id: input.telegramId ?? null,
      action: input.action,
      wallet_address: input.walletAddress?.toLowerCase() ?? null,
      success: input.success,
      reason: input.reason ?? null,
      metadata: input.metadata ?? null,
    });
  } catch (err) {
    console.error('[gate] logAccess failed', err);
  }
}

export async function checkRateLimit(
  telegramId: number,
  bucket: string,
  windowSeconds: number,
  maxRequests: number
): Promise<{ allowed: boolean; remaining: number }> {
  const client = db();
  const now = new Date();
  const { data: existing } = await client
    .from('telegram_rate_limits')
    .select('*')
    .eq('telegram_id', telegramId)
    .eq('bucket', bucket)
    .maybeSingle();

  if (!existing) {
    await client.from('telegram_rate_limits').insert({
      telegram_id: telegramId,
      bucket,
      window_start: now.toISOString(),
      count: 1,
    });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  const windowExpired = Date.now() - new Date(existing.window_start).getTime() > windowSeconds * 1000;
  if (windowExpired) {
    await client
      .from('telegram_rate_limits')
      .update({ window_start: now.toISOString(), count: 1 })
      .eq('telegram_id', telegramId)
      .eq('bucket', bucket);
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (existing.count >= maxRequests) return { allowed: false, remaining: 0 };

  await client
    .from('telegram_rate_limits')
    .update({ count: existing.count + 1 })
    .eq('telegram_id', telegramId)
    .eq('bucket', bucket);
  return { allowed: true, remaining: maxRequests - existing.count - 1 };
}

export async function cleanupExpired(): Promise<{
  links: number;
  nonces: number;
  logs: number;
  cache: number;
}> {
  const client = db();
  const now = new Date().toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

  const [links, nonces, logs, cache] = await Promise.all([
    client.from('telegram_wallet_links').delete().lt('verified_until', now).select('telegram_id'),
    client.from('telegram_auth_nonces').delete().lt('expires_at', now).select('nonce'),
    client.from('telegram_access_log').delete().lt('created_at', thirtyDaysAgo).select('id'),
    client.from('telegram_balance_cache').delete().lt('fetched_at', oneHourAgo).select('wallet_address'),
  ]);

  return {
    links: links.data?.length ?? 0,
    nonces: nonces.data?.length ?? 0,
    logs: logs.data?.length ?? 0,
    cache: cache.data?.length ?? 0,
  };
}
