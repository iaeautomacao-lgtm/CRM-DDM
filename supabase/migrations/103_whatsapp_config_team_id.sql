-- Migration 103: adiciona wacrm.whatsapp_config.team_id + restringe SELECT
-- pra agents só verem canais da própria equipe.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- Schema only nesta fase — nada escreve essa coluna ainda (mesmo padrão de
-- conversations.team_id, migration 049). Nullable de propósito: todo canal
-- existente fica sem equipe até alguém atribuir manualmente.
ALTER TABLE wacrm.whatsapp_config
  ADD COLUMN team_id UUID REFERENCES wacrm.teams(id) ON DELETE SET NULL;

-- Substitui a policy de SELECT criada em 017_account_sharing.sql
-- (is_account_member(account_id), sem distinção de papel). Mesmo padrão de
-- 063_conversations_agent_rls.sql: owner/admin/viewer mantêm acesso total à
-- conta; agent só vê canais da equipe da qual participa (via
-- wacrm.team_members) — MAIS canais sem equipe atribuída (team_id IS NULL),
-- pra não tirar acesso de agents a nenhum canal existente até as equipes
-- serem configuradas.
DROP POLICY IF EXISTS whatsapp_config_select ON wacrm.whatsapp_config;
CREATE POLICY whatsapp_config_select ON wacrm.whatsapp_config FOR SELECT USING (
  wacrm.is_account_member(account_id)
  AND (
    NOT EXISTS (
      SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = auth.uid() AND p.account_role = 'agent'
    )
    OR team_id IN (
      SELECT team_id FROM wacrm.team_members WHERE user_id = auth.uid()
    )
    OR team_id IS NULL
  )
);
