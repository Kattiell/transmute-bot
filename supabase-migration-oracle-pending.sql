-- Pending /oracle state. When a user runs /oracle without providing a CA inline,
-- the bot stores a row here and waits for the next plain-text message from the
-- same user to be the contract address. Rows have a short TTL (5 minutes by
-- default) so a forgotten flow doesn't lock the user out forever.
CREATE TABLE IF NOT EXISTS telegram_pending_oracle (
  telegram_id BIGINT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_pending_oracle_expires_idx
  ON telegram_pending_oracle (expires_at);
