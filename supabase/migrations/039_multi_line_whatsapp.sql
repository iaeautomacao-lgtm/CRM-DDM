-- ============================================================
-- Support multiple WhatsApp lines/sessions per account
-- ============================================================

-- 1. Drop the UNIQUE constraint that limits one config per account
ALTER TABLE wacrm.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- 2. Add a UNIQUE index on (account_id, waha_session) so the same session is not duplicated for the same account
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_account_waha_session
  ON wacrm.whatsapp_config(account_id, waha_session)
  WHERE provider = 'waha';

-- 3. Add waha_session to conversations
ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS waha_session TEXT;

-- 4. Add waha_session to messages
ALTER TABLE wacrm.messages
  ADD COLUMN IF NOT EXISTS waha_session TEXT;

-- 5. Backfill waha_session for existing conversations and messages
-- Update conversations to use the waha_session from whatsapp_config for that account
UPDATE wacrm.conversations c
SET waha_session = wc.waha_session
FROM wacrm.whatsapp_config wc
WHERE c.account_id = wc.account_id
  AND wc.provider = 'waha'
  AND c.waha_session IS NULL;

UPDATE wacrm.messages m
SET waha_session = c.waha_session
FROM wacrm.conversations c
WHERE m.conversation_id = c.id
  AND m.waha_session IS NULL;
