-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (sem outro comando junto).
--    Junto com outro comando o Supabase abre transação e dá 25001; e desfaz TUDO o que foi junto.
-- 211b — índice de apoio do vigia de IA travada (stalled_ai_conversations, migration 211).
-- ARQUIVO PRÓPRIO, SEM TRANSAÇÃO: CREATE INDEX CONCURRENTLY não roda dentro de BEGIN/COMMIT.
--
-- Cobre exatamente o predicado que escolhe as candidatas: conversas abertas e sem atendente, por horário da última
-- mensagem do cliente (faixa + ordem). Parcial: só as abertas sem atendente, que são poucas.
--
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_conversations_open_unassigned_customer_msg';
--            (nenhum índice existente serve: idx_conversations_inbox começa por account_id/status e ordena por last_message_at.)
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_conversations_open_unassigned_customer_msg'::regclass;  -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_conversations_open_unassigned_customer_msg;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_open_unassigned_customer_msg
  ON wacrm.conversations (last_customer_message_at)
  WHERE status = 'open' AND assigned_agent_id IS NULL;
