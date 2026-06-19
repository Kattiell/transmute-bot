/**
 * Persistence layer for auto-detected group CA calls (RickBot-style cards)
 * and the /flex flexcard feature.
 *
 * Table (defined in supabase-migration-token-calls.sql):
 *   token_calls — one row per (chat_id, contract_address). The first user to
 *   post a CA in a group owns the call; their handle and the FDV at that
 *   moment are frozen into the row. cron-update-ath keeps ath_fdv fresh.
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

export interface TokenCall {
  id: number;
  chat_id: number;
  chat_title: string | null;
  contract_address: string;
  chain: string;
  ticker: string | null;
  name: string | null;
  dexscreener_url: string | null;
  caller_telegram_id: number;
  caller_username: string | null;
  caller_first_name: string | null;
  fdv_at_call: number | null;
  price_usd_at_call: number | null;
  liquidity_at_call: number | null;
  ath_fdv: number | null;
  ath_price_usd: number | null;
  ath_recorded_at: string | null;
  last_polled_at: string | null;
  last_card_at: string | null;
  is_active: boolean;
  called_at: string;
}

/**
 * Insert-if-absent. The unique (chat_id, contract_address) constraint makes
 * this race-safe: when two messages with the same CA land simultaneously,
 * exactly one insert wins and both callers read the same winning row back.
 */
export async function recordTokenCall(input: {
  chatId: number;
  chatTitle?: string | null;
  contractAddress: string;
  chain?: string;
  ticker?: string | null;
  name?: string | null;
  dexscreenerUrl?: string | null;
  callerTelegramId: number;
  callerUsername?: string | null;
  callerFirstName?: string | null;
  fdvAtCall?: number | null;
  priceUsdAtCall?: number | null;
  liquidityAtCall?: number | null;
}): Promise<{ call: TokenCall; isNew: boolean } | null> {
  const ca = input.contractAddress.toLowerCase();
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('token_calls')
    .upsert(
      {
        chat_id: input.chatId,
        chat_title: input.chatTitle ?? null,
        contract_address: ca,
        chain: input.chain ?? 'base',
        ticker: input.ticker ?? null,
        name: input.name ?? null,
        dexscreener_url: input.dexscreenerUrl ?? null,
        caller_telegram_id: input.callerTelegramId,
        caller_username: input.callerUsername ?? null,
        caller_first_name: input.callerFirstName ?? null,
        fdv_at_call: input.fdvAtCall ?? null,
        price_usd_at_call: input.priceUsdAtCall ?? null,
        liquidity_at_call: input.liquidityAtCall ?? null,
        ath_fdv: input.fdvAtCall ?? null,
        ath_price_usd: input.priceUsdAtCall ?? null,
        ath_recorded_at: now,
        last_polled_at: now,
        is_active: true,
        called_at: now,
      },
      { onConflict: 'chat_id,contract_address', ignoreDuplicates: true },
    )
    .select()
    .maybeSingle();

  if (error) {
    console.error('[tokencalls] recordTokenCall failed', error);
    return null;
  }
  if (data) return { call: data as TokenCall, isNew: true };

  // Conflict: someone already called this CA in this chat — return theirs.
  const existing = await getTokenCall(input.chatId, ca);
  return existing ? { call: existing, isNew: false } : null;
}

export async function getTokenCall(chatId: number, ca: string): Promise<TokenCall | null> {
  const { data } = await db()
    .from('token_calls')
    .select('*')
    .eq('chat_id', chatId)
    .eq('contract_address', ca.toLowerCase())
    .maybeSingle();
  return (data as TokenCall) ?? null;
}

/** Earliest call of a CA across all chats — the "original caller" for /flex in DM. */
export async function getEarliestTokenCall(ca: string): Promise<TokenCall | null> {
  const { data } = await db()
    .from('token_calls')
    .select('*')
    .eq('contract_address', ca.toLowerCase())
    .order('called_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as TokenCall) ?? null;
}

/** Most recent call in a chat — lets bare /flex inside a group flex the latest call. */
export async function getLatestTokenCallForChat(chatId: number): Promise<TokenCall | null> {
  const { data } = await db()
    .from('token_calls')
    .select('*')
    .eq('chat_id', chatId)
    .order('called_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as TokenCall) ?? null;
}

export async function markTokenCallCardSent(id: number): Promise<void> {
  await db()
    .from('token_calls')
    .update({ last_card_at: new Date().toISOString() })
    .eq('id', id);
}

// ─────────────────────────────────────────────────────────────────────────────
// ATH polling (shared with api/cron-update-ath.ts)
// ─────────────────────────────────────────────────────────────────────────────

export async function listTokenCallsToPoll(maxAgeDays = 30, limit = 200): Promise<TokenCall[]> {
  const since = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
  const { data } = await db()
    .from('token_calls')
    .select('*')
    .eq('is_active', true)
    .gte('called_at', since)
    .order('last_polled_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  return (data as TokenCall[] | null) ?? [];
}

/**
 * Raise ath_fdv for every row tracking this CA (the same token may be called
 * in several chats — one DexScreener fetch updates them all).
 */
export async function raiseTokenCallAthByCa(input: {
  contractAddress: string;
  newAthFdv: number;
  newAthPriceUsd: number | null;
}): Promise<void> {
  const now = new Date().toISOString();
  // L12 (CWE-89 defense-in-depth): newAthFdv is interpolated into a PostgREST
  // `.or()` raw filter below, so coerce + validate it as a finite number first.
  const athFdv = Number(input.newAthFdv);
  if (!Number.isFinite(athFdv)) return;
  await db()
    .from('token_calls')
    .update({
      ath_fdv: athFdv,
      ath_price_usd: input.newAthPriceUsd,
      ath_recorded_at: now,
      last_polled_at: now,
    })
    .eq('contract_address', input.contractAddress.toLowerCase())
    .or(`ath_fdv.is.null,ath_fdv.lt.${athFdv}`);
}

export async function touchTokenCallPollByCa(ca: string): Promise<void> {
  await db()
    .from('token_calls')
    .update({ last_polled_at: new Date().toISOString() })
    .eq('contract_address', ca.toLowerCase());
}

/** Retire calls past the polling window so the cron stops spending quota on them. */
export async function deactivateTokenCallsOlderThan(maxAgeDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
  const { data } = await db()
    .from('token_calls')
    .update({ is_active: false })
    .eq('is_active', true)
    .lt('called_at', cutoff)
    .select('id');
  return data?.length ?? 0;
}
