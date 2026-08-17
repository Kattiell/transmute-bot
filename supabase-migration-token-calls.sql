-- ============================================================================
-- Token Calls — auto-detected CA mentions in groups (RickBot-style cards)
-- ============================================================================
-- Run after supabase-migration-call-now.sql.
-- All identifiers are guarded with IF NOT EXISTS so the migration is idempotent.
--
-- One row per (chat, contract). The FIRST user to post a CA in a group owns
-- the call: their handle + the FDV snapshot at that moment are frozen into the
-- row. Subsequent mentions re-render the card crediting the original caller.
-- /flex reads this table to mint the flexcard image, and cron-update-ath
-- keeps ath_fdv fresh so multipliers reflect the post-call peak.

CREATE TABLE IF NOT EXISTS token_calls (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  chat_title TEXT,
  contract_address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  ticker TEXT,
  name TEXT,
  dexscreener_url TEXT,
  caller_telegram_id BIGINT NOT NULL,
  caller_username TEXT,
  caller_first_name TEXT,
  fdv_at_call NUMERIC,
  price_usd_at_call NUMERIC,
  liquidity_at_call NUMERIC,
  ath_fdv NUMERIC,
  ath_price_usd NUMERIC,
  ath_recorded_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  -- Last time the bot replied with a card for this (chat, ca). Drives the
  -- anti-spam cooldown so repeated pastes don't flood the group.
  last_card_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT token_calls_chat_ca_unique UNIQUE (chat_id, contract_address)
);

CREATE INDEX IF NOT EXISTS token_calls_poll_idx ON token_calls (is_active, last_polled_at);
CREATE INDEX IF NOT EXISTS token_calls_contract_idx ON token_calls (contract_address);
CREATE INDEX IF NOT EXISTS token_calls_chat_recent_idx ON token_calls (chat_id, called_at DESC);
