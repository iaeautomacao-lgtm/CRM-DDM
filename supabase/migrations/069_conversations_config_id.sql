-- ============================================================
-- 069_conversations_config_id.sql — link a conversation to the
-- whatsapp_config row it arrived on.
--
-- waha_session already let the WAHA webhook (and send/route.ts's
-- config lookup) scope a conversation to its specific line — an
-- account can have several WAHA sessions (migration 039). Meta never
-- had an equivalent: every Meta conversation's whatsapp_config was
-- resolved by "the account's only Meta config", which silently
-- breaks (picks an arbitrary row) once a second Meta number is
-- connected to the same account.
--
-- Nullable, and ON DELETE SET NULL like flow_runs.config_id
-- (migration 057) for the same reason: conversation history must
-- survive a channel being deleted via /canais, and a bare FK
-- (default NO ACTION) would instead block that delete the moment any
-- conversation referenced the channel.
--
-- Idempotent — safe to run multiple times. File only, NOT applied to
-- the database by this session.
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS config_id UUID
    REFERENCES wacrm.whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_config_id
  ON wacrm.conversations(config_id)
  WHERE config_id IS NOT NULL;
