/**
 * DB layer for the /forge wizard (telegram_pending_forge) and the launch
 * audit log (oracle_forge_launches).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export type ForgeStep = 'awaiting_name' | 'awaiting_ticker' | 'awaiting_image' | 'awaiting_confirm';

export interface PendingForge {
  telegram_id: number;
  step: ForgeStep;
  token_name: string | null;
  token_symbol: string | null;
  image_url: string | null;
  expires_at: string;
  created_at: string;
}

export async function setPendingForgeStep(input: {
  telegramId: number;
  step: ForgeStep;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  imageUrl?: string | null;
  ttlSeconds?: number;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 600) * 1000).toISOString();
  await db()
    .from('telegram_pending_forge')
    .upsert(
      {
        telegram_id: input.telegramId,
        step: input.step,
        token_name: input.tokenName ?? null,
        token_symbol: input.tokenSymbol ?? null,
        image_url: input.imageUrl ?? null,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_id' },
    );
}

export async function getPendingForge(telegramId: number): Promise<PendingForge | null> {
  const { data } = await db()
    .from('telegram_pending_forge')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (!data) return null;
  if (new Date((data as PendingForge).expires_at).getTime() <= Date.now()) {
    await clearPendingForge(telegramId);
    return null;
  }
  return data as PendingForge;
}

export async function clearPendingForge(telegramId: number): Promise<void> {
  await db().from('telegram_pending_forge').delete().eq('telegram_id', telegramId);
}

export interface ForgeLaunchRow {
  id: number;
  caller_telegram_id: number;
  caller_username: string | null;
  token_name: string;
  token_symbol: string;
  image_url: string | null;
  fee_recipient_wallet: string | null;
  status: 'pending' | 'success' | 'failed';
  bankr_response: Record<string, unknown> | null;
  contract_address: string | null;
  transaction_hash: string | null;
  error_message: string | null;
  created_at: string;
}

export async function recordForgeAttempt(input: {
  callerTelegramId: number;
  callerUsername?: string | null;
  tokenName: string;
  tokenSymbol: string;
  imageUrl?: string | null;
  feeRecipientWallet?: string | null;
}): Promise<ForgeLaunchRow> {
  const { data, error } = await db()
    .from('oracle_forge_launches')
    .insert({
      caller_telegram_id: input.callerTelegramId,
      caller_username: input.callerUsername ?? null,
      token_name: input.tokenName,
      token_symbol: input.tokenSymbol,
      image_url: input.imageUrl ?? null,
      fee_recipient_wallet: input.feeRecipientWallet ?? null,
      status: 'pending',
    })
    .select()
    .single();
  if (error) throw error;
  return data as ForgeLaunchRow;
}

export async function markForgeSuccess(id: number, payload: {
  contractAddress?: string | null;
  transactionHash?: string | null;
  bankrResponse: Record<string, unknown>;
}): Promise<void> {
  await db()
    .from('oracle_forge_launches')
    .update({
      status: 'success',
      contract_address: payload.contractAddress ?? null,
      transaction_hash: payload.transactionHash ?? null,
      bankr_response: payload.bankrResponse,
    })
    .eq('id', id);
}

export async function markForgeFailure(id: number, errorMessage: string, bankrResponse?: Record<string, unknown>): Promise<void> {
  await db()
    .from('oracle_forge_launches')
    .update({
      status: 'failed',
      error_message: errorMessage,
      bankr_response: bankrResponse ?? null,
    })
    .eq('id', id);
}
