-- =============================================================
-- Migration: telegram_processed_updates
-- Idempotency store for Telegram webhook update_id so retries
-- (Telegram retries up to ~25x when a webhook doesn't 200 within
-- ~60s) can't re-fire long-running commands like /invoke.
-- =============================================================

CREATE TABLE IF NOT EXISTS telegram_processed_updates (
  update_id bigint PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_processed_at
  ON telegram_processed_updates (processed_at);

ALTER TABLE telegram_processed_updates ENABLE ROW LEVEL SECURITY;
