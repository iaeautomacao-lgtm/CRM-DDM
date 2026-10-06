-- ============================================================
-- 150_intelligence_chats.sql — histórico do chat do DDM Intelligence
-- (PRD-04, Fase 2).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy (a rota
-- POST /api/intelligence/chat e a página /inteligencia dependem dela).
-- Conferir o schema live antes (CLAUDE.md): wacrm.accounts e
-- wacrm.is_account_member(uuid) precisam existir (017/140).
--
-- intelligence_chats    → uma conversa do usuário com a IA interna.
-- intelligence_messages → perguntas (role 'user') e respostas
--   ('assistant'). tool_calls guarda só nome/argumentos/sucesso/duração
--   das ferramentas usadas, nunca o resultado. account_id é denormalizado
--   para o teto diário por conta (INTELLIGENCE_DAILY_MAX_MESSAGES) contar
--   por índice, sem join.
--
-- Leitura: cada usuário vê SÓ os próprios chats (user_id = auth.uid() e
-- membro da conta) — supervisor não vê histórico de ninguém, e owner/admin
-- também não veem o histórico dos outros. Escrita: só o servidor
-- (service_role).
--
-- Idempotente.
-- ============================================================

BEGIN;

SET search_path TO wacrm, public, extensions;

CREATE TABLE IF NOT EXISTS wacrm.intelligence_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Nova conversa',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intelligence_chats_user_updated
  ON wacrm.intelligence_chats (account_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS wacrm.intelligence_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES wacrm.intelligence_chats(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  tool_calls jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_intelligence_messages_chat_created
  ON wacrm.intelligence_messages (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_messages_account_role_created
  ON wacrm.intelligence_messages (account_id, role, created_at DESC);

ALTER TABLE wacrm.intelligence_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.intelligence_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intelligence_chats_select_own ON wacrm.intelligence_chats;
CREATE POLICY intelligence_chats_select_own ON wacrm.intelligence_chats FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() AND is_account_member(account_id));

DROP POLICY IF EXISTS intelligence_messages_select_own ON wacrm.intelligence_messages;
CREATE POLICY intelligence_messages_select_own ON wacrm.intelligence_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM wacrm.intelligence_chats c
      WHERE c.id = intelligence_messages.chat_id
        AND c.user_id = auth.uid()
        AND is_account_member(c.account_id)
    )
  );

REVOKE ALL ON wacrm.intelligence_chats FROM PUBLIC, anon;
REVOKE ALL ON wacrm.intelligence_messages FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON wacrm.intelligence_chats FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON wacrm.intelligence_messages FROM authenticated;
GRANT SELECT ON wacrm.intelligence_chats TO authenticated;
GRANT SELECT ON wacrm.intelligence_messages TO authenticated;
GRANT ALL ON wacrm.intelligence_chats TO service_role;
GRANT ALL ON wacrm.intelligence_messages TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
