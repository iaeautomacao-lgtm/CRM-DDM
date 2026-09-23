-- Migration 109: wacrm.internal_messages — 1:1 staff chat (operador
-- <-> supervisor), separate from the customer-facing WhatsApp
-- conversations/messages tables. No thread/channel row: a "thread"
-- between two users is just every row where they're sender+recipient
-- of each other, queried directly by (sender_id, recipient_id) pair.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

CREATE TABLE IF NOT EXISTS wacrm.internal_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_internal_messages_account ON wacrm.internal_messages(account_id);
CREATE INDEX IF NOT EXISTS idx_internal_messages_thread ON wacrm.internal_messages(account_id, sender_id, recipient_id);

ALTER TABLE wacrm.internal_messages ENABLE ROW LEVEL SECURITY;

-- Usuário vê mensagens onde é sender ou recipient, dentro da mesma conta
CREATE POLICY "internal_messages_select" ON wacrm.internal_messages
  FOR SELECT USING (
    (auth.uid() = sender_id OR auth.uid() = recipient_id)
    AND wacrm.is_account_member(account_id)
  );

CREATE POLICY "internal_messages_insert" ON wacrm.internal_messages
  FOR INSERT WITH CHECK (
    auth.uid() = sender_id
    AND wacrm.is_account_member(account_id)
  );

CREATE POLICY "internal_messages_update" ON wacrm.internal_messages
  FOR UPDATE USING (auth.uid() = recipient_id)
  WITH CHECK (auth.uid() = recipient_id);

-- ---- realtime ----------------------------------------------
-- Not in the spec this migration was drafted from, but required for
-- InternalChatDialog's Realtime subscription to ever fire — every
-- other Realtime-backed table in this codebase (messages,
-- conversations, message_reactions, flow_runs, member_presence) has
-- this same ADD TABLE step; skipping it here would leave the feature
-- silently non-live (INSERTs would only ever show up after a manual
-- refetch, never push).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'wacrm' AND tablename = 'internal_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wacrm.internal_messages;
  END IF;
END $$;
