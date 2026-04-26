/**
 * Persistence layer for the /callnow + /gods (Pantheon) feature set.
 *
 * Tables (defined in supabase-migration-call-now.sql):
 *   telegram_pending_call          — wizard state for /callnow
 *   oracle_call_submissions        — submissions awaiting admin review
 *   oracle_calls                   — approved calls (source of /gods)
 *   oracle_group_subscriptions     — groups opted-in to broadcast
 *   telegram_signal_optout         — DM users who opted out
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

// ─────────────────────────────────────────────────────────────────────────────
// Pending /callnow wizard state
// ─────────────────────────────────────────────────────────────────────────────

export type CallWizardStep = 'awaiting_ca' | 'awaiting_thesis';

export interface PendingCall {
  telegram_id: number;
  step: CallWizardStep;
  ca: string | null;
  ticker: string | null;
  name: string | null;
  fdv_usd: number | null;
  liquidity_usd: number | null;
  expires_at: string;
  created_at: string;
}

export async function setPendingCallStep(input: {
  telegramId: number;
  step: CallWizardStep;
  ca?: string | null;
  ticker?: string | null;
  name?: string | null;
  fdvUsd?: number | null;
  liquidityUsd?: number | null;
  ttlSeconds?: number;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 600) * 1000).toISOString();
  await db()
    .from('telegram_pending_call')
    .upsert(
      {
        telegram_id: input.telegramId,
        step: input.step,
        ca: input.ca ?? null,
        ticker: input.ticker ?? null,
        name: input.name ?? null,
        fdv_usd: input.fdvUsd ?? null,
        liquidity_usd: input.liquidityUsd ?? null,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_id' },
    );
}

export async function getPendingCall(telegramId: number): Promise<PendingCall | null> {
  const { data } = await db()
    .from('telegram_pending_call')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (!data) return null;
  if (new Date((data as PendingCall).expires_at).getTime() <= Date.now()) {
    await clearPendingCall(telegramId);
    return null;
  }
  return data as PendingCall;
}

export async function clearPendingCall(telegramId: number): Promise<void> {
  await db().from('telegram_pending_call').delete().eq('telegram_id', telegramId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Submissions
// ─────────────────────────────────────────────────────────────────────────────

export interface CallSubmission {
  id: number;
  caller_telegram_id: number;
  caller_username: string | null;
  caller_first_name: string | null;
  contract_address: string;
  chain: string;
  ticker: string | null;
  name: string | null;
  thesis: string;
  fdv_at_submit: number | null;
  liquidity_at_submit: number | null;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  reviewed_by_telegram_id: number | null;
  reviewed_at: string | null;
  created_at: string;
}

export async function createCallSubmission(input: {
  callerTelegramId: number;
  callerUsername?: string | null;
  callerFirstName?: string | null;
  contractAddress: string;
  ticker?: string | null;
  name?: string | null;
  thesis: string;
  fdvAtSubmit?: number | null;
  liquidityAtSubmit?: number | null;
  chain?: string;
}): Promise<CallSubmission> {
  const { data, error } = await db()
    .from('oracle_call_submissions')
    .insert({
      caller_telegram_id: input.callerTelegramId,
      caller_username: input.callerUsername ?? null,
      caller_first_name: input.callerFirstName ?? null,
      contract_address: input.contractAddress.toLowerCase(),
      chain: input.chain ?? 'base',
      ticker: input.ticker ?? null,
      name: input.name ?? null,
      thesis: input.thesis,
      fdv_at_submit: input.fdvAtSubmit ?? null,
      liquidity_at_submit: input.liquidityAtSubmit ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as CallSubmission;
}

export async function getSubmission(id: number): Promise<CallSubmission | null> {
  const { data } = await db()
    .from('oracle_call_submissions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  return (data as CallSubmission) ?? null;
}

export async function markSubmissionReviewed(input: {
  id: number;
  status: 'approved' | 'rejected';
  reviewerTelegramId: number;
  rejectionReason?: string | null;
}): Promise<CallSubmission | null> {
  const { data } = await db()
    .from('oracle_call_submissions')
    .update({
      status: input.status,
      reviewed_by_telegram_id: input.reviewerTelegramId,
      reviewed_at: new Date().toISOString(),
      rejection_reason: input.rejectionReason ?? null,
    })
    .eq('id', input.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  return (data as CallSubmission) ?? null;
}

/**
 * Returns the caller's most recent submission inside the cooldown window,
 * counting only states that should block re-submission. Rejected submissions
 * do NOT count — a rejected caller can immediately try again with a better
 * thesis. Pending or approved submissions enforce the cooldown.
 */
export async function recentCallByCaller(
  callerTelegramId: number,
  windowSeconds: number,
): Promise<CallSubmission | null> {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { data } = await db()
    .from('oracle_call_submissions')
    .select('*')
    .eq('caller_telegram_id', callerTelegramId)
    .in('status', ['pending', 'approved'])
    .gt('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CallSubmission) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approved calls
// ─────────────────────────────────────────────────────────────────────────────

export interface OracleCall {
  id: number;
  submission_id: number | null;
  caller_telegram_id: number;
  caller_username: string | null;
  caller_first_name: string | null;
  contract_address: string;
  chain: string;
  ticker: string | null;
  name: string | null;
  dexscreener_url: string | null;
  thesis: string;
  fdv_at_call: number | null;
  mcap_at_call: number | null;
  liquidity_at_call: number | null;
  price_usd_at_call: number | null;
  ath_fdv: number | null;
  ath_price_usd: number | null;
  ath_recorded_at: string | null;
  last_polled_at: string | null;
  is_active: boolean;
  approved_at: string;
}

export async function createApprovedCall(input: {
  submissionId: number;
  callerTelegramId: number;
  callerUsername?: string | null;
  callerFirstName?: string | null;
  contractAddress: string;
  chain?: string;
  ticker?: string | null;
  name?: string | null;
  dexscreenerUrl?: string | null;
  thesis: string;
  fdvAtCall?: number | null;
  mcapAtCall?: number | null;
  liquidityAtCall?: number | null;
  priceUsdAtCall?: number | null;
}): Promise<OracleCall> {
  const fdv = input.fdvAtCall ?? null;
  const price = input.priceUsdAtCall ?? null;
  const { data, error } = await db()
    .from('oracle_calls')
    .insert({
      submission_id: input.submissionId,
      caller_telegram_id: input.callerTelegramId,
      caller_username: input.callerUsername ?? null,
      caller_first_name: input.callerFirstName ?? null,
      contract_address: input.contractAddress.toLowerCase(),
      chain: input.chain ?? 'base',
      ticker: input.ticker ?? null,
      name: input.name ?? null,
      dexscreener_url: input.dexscreenerUrl ?? null,
      thesis: input.thesis,
      fdv_at_call: fdv,
      mcap_at_call: input.mcapAtCall ?? null,
      liquidity_at_call: input.liquidityAtCall ?? null,
      price_usd_at_call: price,
      ath_fdv: fdv,
      ath_price_usd: price,
      ath_recorded_at: new Date().toISOString(),
      last_polled_at: new Date().toISOString(),
      is_active: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data as OracleCall;
}

/** Active calls eligible for ATH polling. Default 30-day window. */
export async function listActiveCallsToPoll(maxAgeDays = 30, limit = 200): Promise<OracleCall[]> {
  const since = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
  const { data } = await db()
    .from('oracle_calls')
    .select('*')
    .eq('is_active', true)
    .gte('approved_at', since)
    .order('last_polled_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  return (data as OracleCall[] | null) ?? [];
}

export async function updateCallAth(input: {
  id: number;
  newAthFdv: number;
  newAthPriceUsd: number | null;
}): Promise<void> {
  await db()
    .from('oracle_calls')
    .update({
      ath_fdv: input.newAthFdv,
      ath_price_usd: input.newAthPriceUsd,
      ath_recorded_at: new Date().toISOString(),
      last_polled_at: new Date().toISOString(),
    })
    .eq('id', input.id);
}

export async function touchCallPollTime(id: number): Promise<void> {
  await db()
    .from('oracle_calls')
    .update({ last_polled_at: new Date().toISOString() })
    .eq('id', id);
}

export async function deactivateCall(id: number): Promise<void> {
  await db().from('oracle_calls').update({ is_active: false }).eq('id', id);
}

export async function listCallsInWindow(days: number, limit = 200): Promise<OracleCall[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data } = await db()
    .from('oracle_calls')
    .select('*')
    .gte('approved_at', since)
    .order('approved_at', { ascending: false })
    .limit(limit);
  return (data as OracleCall[] | null) ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Group subscriptions (broadcast opt-in)
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupSubscription {
  chat_id: number;
  chat_title: string | null;
  subscribed_by_telegram_id: number;
  subscribed_by_username: string | null;
  subscribed_at: string;
}

export async function addGroupSubscription(input: {
  chatId: number;
  chatTitle?: string | null;
  subscribedByTelegramId: number;
  subscribedByUsername?: string | null;
}): Promise<void> {
  await db()
    .from('oracle_group_subscriptions')
    .upsert(
      {
        chat_id: input.chatId,
        chat_title: input.chatTitle ?? null,
        subscribed_by_telegram_id: input.subscribedByTelegramId,
        subscribed_by_username: input.subscribedByUsername ?? null,
        subscribed_at: new Date().toISOString(),
      },
      { onConflict: 'chat_id' },
    );
}

export async function removeGroupSubscription(chatId: number): Promise<void> {
  await db().from('oracle_group_subscriptions').delete().eq('chat_id', chatId);
}

export async function isGroupSubscribed(chatId: number): Promise<boolean> {
  const { data } = await db()
    .from('oracle_group_subscriptions')
    .select('chat_id')
    .eq('chat_id', chatId)
    .maybeSingle();
  return !!data;
}

export async function listSubscribedGroupIds(): Promise<number[]> {
  const { data } = await db().from('oracle_group_subscriptions').select('chat_id');
  return ((data ?? []) as { chat_id: number }[]).map((r) => r.chat_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Group membership tracking (auto-populated via my_chat_member)
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertGroupMembership(input: {
  chatId: number;
  chatTitle?: string | null;
  chatType: 'group' | 'supergroup' | 'channel';
}): Promise<void> {
  const now = new Date().toISOString();
  await db()
    .from('telegram_groups')
    .upsert(
      {
        chat_id: input.chatId,
        chat_title: input.chatTitle ?? null,
        chat_type: input.chatType,
        is_active: true,
        joined_at: now,
        left_at: null,
        last_seen_at: now,
      },
      { onConflict: 'chat_id' },
    );
}

export async function markGroupLeft(chatId: number): Promise<void> {
  await db()
    .from('telegram_groups')
    .update({ is_active: false, left_at: new Date().toISOString() })
    .eq('chat_id', chatId);
}

export async function listActiveGroupIds(): Promise<number[]> {
  const { data } = await db()
    .from('telegram_groups')
    .select('chat_id')
    .eq('is_active', true);
  return ((data ?? []) as { chat_id: number }[]).map((r) => r.chat_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// DM signal opt-out
// ─────────────────────────────────────────────────────────────────────────────

export async function setDmOptOut(telegramId: number, optOut: boolean): Promise<void> {
  if (optOut) {
    await db()
      .from('telegram_signal_optout')
      .upsert(
        { telegram_id: telegramId, opted_out_at: new Date().toISOString() },
        { onConflict: 'telegram_id' },
      );
  } else {
    await db().from('telegram_signal_optout').delete().eq('telegram_id', telegramId);
  }
}

/** Telegram IDs of DM users opted into receiving broadcast signals (default: all who /start'd, minus opt-outs). */
export async function listOptedInDmTargets(limit = 5000): Promise<number[]> {
  const client = db();
  const [usersRes, optoutRes] = await Promise.all([
    client.from('telegram_users').select('telegram_id').limit(limit),
    client.from('telegram_signal_optout').select('telegram_id'),
  ]);
  const optedOut = new Set(((optoutRes.data ?? []) as { telegram_id: number }[]).map((r) => r.telegram_id));
  return ((usersRes.data ?? []) as { telegram_id: number }[])
    .map((r) => r.telegram_id)
    .filter((id) => !optedOut.has(id));
}
