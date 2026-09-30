-- Migration 117: conversations_select v2 — agent só vê conversas
-- atribuídas diretamente a ele; owner/admin/viewer mantêm acesso total
-- à conta (inalterado).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
--
-- Substitui a policy de 063_conversations_agent_rls.sql, que ainda
-- dava visibilidade a agent via `team_id IN (team_members do agente)`
-- — então uma conversa 'pending' roteada pra equipe e ainda sem
-- assigned_agent_id (ou já atribuída a outro colega) aparecia pra
-- todo mundo da equipe. Esta versão remove esse branch por completo:
-- agent só vê `assigned_agent_id = auth.uid()`, ponto.
--
-- 'supervisor' não existe em account_role_enum — o enum só tem
-- ('owner', 'admin', 'agent', 'viewer') (017_account_sharing.sql).
-- O papel 'admin' já é rotulado "Supervisor" na UI
-- (src/components/settings/role-meta.ts) e já tem acesso total à
-- conta pelo branch NOT EXISTS (role = 'agent') abaixo — não precisa
-- de um branch dedicado.
--
-- IMPACTO A CONFIRMAR ANTES DE APLICAR: src/app/api/whatsapp/send/
-- route.ts:528-530 atribui assigned_agent_id = auth.uid() quando um
-- agent responde uma conversa sem dono ("claim by reply"). Com esta
-- policy, o agent nunca mais vê uma conversa da fila da equipe (com
-- ou sem dono) pra poder abri-la e disparar esse claim — o único
-- caminho de atribuição pra agent passa a ser o cron
-- /api/conversations/retry-assignment ou uma atribuição manual feita
-- por um admin/owner. Se o "pegar na mão" ainda for desejado, esta
-- migration não deve ser aplicada como está.

DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;

CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (
  is_account_member(account_id)
  AND (
    -- owner/admin/viewer: acesso total à conta (inalterado).
    NOT EXISTS (
      SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role = 'agent'
    )
    -- agent: só o que está atribuído a ele diretamente — sem branch
    -- de team_id, ao contrário da v1 (063).
    OR assigned_agent_id = auth.uid()
  )
);
