-- =============================================================
-- Migration: Token-gated Telegram access codes
-- Adds:
--   telegram_access_codes        — hashed weekly codes (TXM-XXXX-XXXX)
--   telegram_code_challenges     — signature challenges for code generation
--   telegram_premium_daily_usage — per-day usage counter for premium cmds
--   telegram_wallet_links.source — track how the link was created
-- =============================================================

-- 1. telegram_access_codes
-- One active code per wallet (enforced in app logic + partial unique index).
-- Codes are never stored in plaintext — only sha256 hex.
CREATE TABLE IF NOT EXISTS telegram_access_codes (
  id                 bigserial PRIMARY KEY,
  code_hash          text NOT NULL UNIQUE,
  wallet_address     text NOT NULL,
  telegram_id        bigint,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  revoked_at         timestamptz,
  balance_at_issue   numeric NOT NULL DEFAULT 0,
  issuer_ip          text,
  user_agent         text
);

CREATE INDEX IF NOT EXISTS idx_tg_codes_wallet
  ON telegram_access_codes (wallet_address);
CREATE INDEX IF NOT EXISTS idx_tg_codes_expires
  ON telegram_access_codes (expires_at);
-- At most one active (not consumed, not revoked, not expired) code per wallet
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tg_codes_active_per_wallet
  ON telegram_access_codes (wallet_address)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- 2. telegram_code_challenges
-- One-shot nonces that the user signs when requesting a code.
CREATE TABLE IF NOT EXISTS telegram_code_challenges (
  nonce              text PRIMARY KEY,
  wallet_address     text NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_tg_code_challenges_wallet
  ON telegram_code_challenges (wallet_address);
CREATE INDEX IF NOT EXISTS idx_tg_code_challenges_expires
  ON telegram_code_challenges (expires_at);

-- 3. telegram_premium_daily_usage
-- Tracks per-day counters for premium commands (e.g. /invoke max 3/day).
-- usage_date is always stored in UTC; reset happens at UTC midnight by design.
CREATE TABLE IF NOT EXISTS telegram_premium_daily_usage (
  telegram_id        bigint NOT NULL,
  command            text NOT NULL,
  usage_date         date NOT NULL,
  count              int NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, command, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_tg_daily_usage_date
  ON telegram_premium_daily_usage (usage_date);

-- 4. Track how a wallet link was created (signature vs code redemption)
ALTER TABLE telegram_wallet_links
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'signature';

-- RLS
ALTER TABLE telegram_access_codes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_code_challenges         ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_premium_daily_usage     ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "service_role all on telegram_access_codes"
    ON telegram_access_codes FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all on telegram_code_challenges"
    ON telegram_code_challenges FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all on telegram_premium_daily_usage"
    ON telegram_premium_daily_usage FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
