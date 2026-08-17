-- ============================================================================
-- Step 2: Call Now + Pantheon (/gods) leaderboard
-- ============================================================================
-- Run after supabase-migration-oracle-pending.sql.
-- All identifiers are guarded with IF NOT EXISTS so the migration is idempotent.

-- 1. Pending wizard state for /callnow. Two-step flow: awaiting_ca → awaiting_thesis.
CREATE TABLE IF NOT EXISTS telegram_pending_call (
  telegram_id BIGINT PRIMARY KEY,
  step TEXT NOT NULL CHECK (step IN ('awaiting_ca', 'awaiting_thesis')),
  ca TEXT,
  ticker TEXT,
  name TEXT,
  fdv_usd NUMERIC,
  liquidity_usd NUMERIC,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_pending_call_expires_idx ON telegram_pending_call (expires_at);

-- 2. Call submissions awaiting human review.
CREATE TABLE IF NOT EXISTS oracle_call_submissions (
  id BIGSERIAL PRIMARY KEY,
  caller_telegram_id BIGINT NOT NULL,
  caller_username TEXT,
  caller_first_name TEXT,
  contract_address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  ticker TEXT,
  name TEXT,
  thesis TEXT NOT NULL,
  fdv_at_submit NUMERIC,
  liquidity_at_submit NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  reviewed_by_telegram_id BIGINT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oracle_call_submissions_status_idx ON oracle_call_submissions (status);
CREATE INDEX IF NOT EXISTS oracle_call_submissions_caller_idx ON oracle_call_submissions (caller_telegram_id);

-- 3. Approved calls — source of truth for /gods leaderboard.
CREATE TABLE IF NOT EXISTS oracle_calls (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT REFERENCES oracle_call_submissions(id) ON DELETE SET NULL,
  caller_telegram_id BIGINT NOT NULL,
  caller_username TEXT,
  caller_first_name TEXT,
  contract_address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  ticker TEXT,
  name TEXT,
  dexscreener_url TEXT,
  thesis TEXT NOT NULL,
  fdv_at_call NUMERIC,
  mcap_at_call NUMERIC,
  liquidity_at_call NUMERIC,
  price_usd_at_call NUMERIC,
  ath_fdv NUMERIC,
  ath_price_usd NUMERIC,
  ath_recorded_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oracle_calls_active_idx ON oracle_calls (is_active, approved_at DESC);
CREATE INDEX IF NOT EXISTS oracle_calls_caller_idx ON oracle_calls (caller_telegram_id);
CREATE INDEX IF NOT EXISTS oracle_calls_contract_idx ON oracle_calls (contract_address);

-- 4. Group opt-in for broadcast. A group admin runs /subscribe inside the group.
CREATE TABLE IF NOT EXISTS oracle_group_subscriptions (
  chat_id BIGINT PRIMARY KEY,
  chat_title TEXT,
  subscribed_by_telegram_id BIGINT NOT NULL,
  subscribed_by_username TEXT,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Per-user broadcast opt-out (default: opted in when user runs /start).
CREATE TABLE IF NOT EXISTS telegram_signal_optout (
  telegram_id BIGINT PRIMARY KEY,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
