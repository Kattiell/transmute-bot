-- ============================================================================
-- Step 3: /forge — Bankr token launcher wizard
-- ============================================================================

-- Wizard state: name → ticker → image → confirm.
CREATE TABLE IF NOT EXISTS telegram_pending_forge (
  telegram_id BIGINT PRIMARY KEY,
  step TEXT NOT NULL CHECK (step IN ('awaiting_name', 'awaiting_ticker', 'awaiting_image', 'awaiting_confirm')),
  token_name TEXT,
  token_symbol TEXT,
  image_url TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_pending_forge_expires_idx ON telegram_pending_forge (expires_at);

-- Audit trail of forge attempts (success + failure).
CREATE TABLE IF NOT EXISTS oracle_forge_launches (
  id BIGSERIAL PRIMARY KEY,
  caller_telegram_id BIGINT NOT NULL,
  caller_username TEXT,
  token_name TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  image_url TEXT,
  fee_recipient_wallet TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  bankr_response JSONB,
  contract_address TEXT,
  transaction_hash TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oracle_forge_launches_caller_idx ON oracle_forge_launches (caller_telegram_id);
CREATE INDEX IF NOT EXISTS oracle_forge_launches_status_idx ON oracle_forge_launches (status);
