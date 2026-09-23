-- Migration 108: restringe DELETE em wacrm.conversations a admin+.
-- conversations_delete (017_account_sharing.sql) usava min_role='agent'
-- — o mínimo permitido, então operadores podiam excluir qualquer
-- conversa que enxergassem. Investigação confirmou isso como
-- comportamento não intencional; a exclusão passa a exigir admin+.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- DROP + CREATE em vez de ALTER POLICY — mesmo padrão já usado em
-- 017_account_sharing.sql (ex.: message_templates_select) para trocar
-- a USING de uma policy existente; mais previsível entre ambientes do
-- que depender do ALTER POLICY aceitar essa forma.
DROP POLICY IF EXISTS conversations_delete ON wacrm.conversations;
CREATE POLICY conversations_delete ON wacrm.conversations
  FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
