-- ============================================================================
-- Step 4: telegram_groups — auto-tracked group memberships for broadcast
-- ============================================================================
-- Populated by the my_chat_member webhook handler. is_active=false marks groups
-- the bot was removed from (kept for audit, excluded from broadcast).

CREATE TABLE IF NOT EXISTS telegram_groups (
  chat_id BIGINT PRIMARY KEY,
  chat_title TEXT,
  chat_type TEXT NOT NULL CHECK (chat_type IN ('group', 'supergroup', 'channel')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_groups_active_idx ON telegram_groups (is_active);
