-- =============================================================
-- Migration: Telegram Token Gate (external browser signature flow)
-- Tables: telegram_users, telegram_wallet_links,
--         telegram_auth_nonces, telegram_access_log,
--         telegram_balance_cache, telegram_rate_limits
-- =============================================================

-- 1. telegram_users
CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_id        bigint PRIMARY KEY,
  username           text,
  first_name         text,
  language_code      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_last_seen
  ON telegram_users (last_seen_at DESC);

-- 2. telegram_wallet_links
-- Active wallet binding per Telegram user. Expires after 7 days.
CREATE TABLE IF NOT EXISTS telegram_wallet_links (
  telegram_id        bigint PRIMARY KEY REFERENCES telegram_users(telegram_id) ON DELETE CASCADE,
  wallet_address     text NOT NULL,
  chain_id           int NOT NULL,
  balance_at_verify  numeric NOT NULL DEFAULT 0,
  verified_at        timestamptz NOT NULL DEFAULT now(),
  verified_until     timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  signature          text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tg_wallet_links_wallet
  ON telegram_wallet_links (lower(wallet_address));
CREATE INDEX IF NOT EXISTS idx_tg_wallet_links_expiry
  ON telegram_wallet_links (verified_until);

-- 3. telegram_auth_nonces
-- One-shot nonces for signature verification. TTL 10 minutes.
CREATE TABLE IF NOT EXISTS telegram_auth_nonces (
  nonce              text PRIMARY KEY,
  telegram_id        bigint NOT NULL REFERENCES telegram_users(telegram_id) ON DELETE CASCADE,
  wallet_address     text,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_tg_nonces_user
  ON telegram_auth_nonces (telegram_id);
CREATE INDEX IF NOT EXISTS idx_tg_nonces_expiry
  ON telegram_auth_nonces (expires_at);

-- 4. telegram_access_log
CREATE TABLE IF NOT EXISTS telegram_access_log (
  id                 bigserial PRIMARY KEY,
  telegram_id        bigint,
  action             text NOT NULL,
  wallet_address     text,
  success            boolean NOT NULL DEFAULT true,
  reason             text,
  metadata           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tg_access_log_user_date
  ON telegram_access_log (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_access_log_date
  ON telegram_access_log (created_at DESC);

-- 5. telegram_balance_cache
CREATE TABLE IF NOT EXISTS telegram_balance_cache (
  wallet_address     text NOT NULL,
  chain_id           int NOT NULL,
  token_address      text NOT NULL,
  balance            numeric NOT NULL,
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, chain_id, token_address)
);

CREATE INDEX IF NOT EXISTS idx_tg_balance_cache_fetched
  ON telegram_balance_cache (fetched_at);

-- 6. telegram_rate_limits
CREATE TABLE IF NOT EXISTS telegram_rate_limits (
  telegram_id        bigint NOT NULL,
  bucket             text NOT NULL,
  window_start       timestamptz NOT NULL DEFAULT now(),
  count              int NOT NULL DEFAULT 1,
  PRIMARY KEY (telegram_id, bucket)
);

-- RLS
ALTER TABLE telegram_users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_wallet_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_auth_nonces      ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_access_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_balance_cache    ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_rate_limits      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role all on telegram_users"
  ON telegram_users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role all on telegram_wallet_links"
  ON telegram_wallet_links FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role all on telegram_auth_nonces"
  ON telegram_auth_nonces FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role all on telegram_access_log"
  ON telegram_access_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role all on telegram_balance_cache"
  ON telegram_balance_cache FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role all on telegram_rate_limits"
  ON telegram_rate_limits FOR ALL USING (true) WITH CHECK (true);
