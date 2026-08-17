-- 063_conversations_agent_rls.sql
-- Restringe o SELECT de wacrm.conversations para o papel 'agent':
-- só conversas atribuídas diretamente a ele (assigned_agent_id) ou
-- roteadas para uma equipe da qual ele participa (wacrm.team_members,
-- migration 062). owner/admin/viewer mantêm acesso total à conta,
-- exatamente como o is_account_member(account_id) já fazia.
--
-- APENAS O ARQUIVO — esta migration NÃO é aplicada automaticamente.
-- O SQL abaixo será rodado manualmente no Supabase após validação.

DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;

CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (
  is_account_member(account_id)
  AND (
    -- Não-agent (owner/admin/viewer): acesso total à conta, sem
    -- restrição adicional — comportamento inalterado.
    NOT EXISTS (
      SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role = 'agent'
    )
    -- agent: só o que está atribuído a ele...
    OR assigned_agent_id = auth.uid()
    -- ...ou roteado para uma equipe da qual ele é membro.
    OR team_id IN (
      SELECT team_id FROM wacrm.team_members WHERE user_id = auth.uid()
    )
  )
);
