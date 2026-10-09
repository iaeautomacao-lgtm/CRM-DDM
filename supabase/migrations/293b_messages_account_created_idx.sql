-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 293b — índice de apoio das funções do Dashboard (migration 293), RECOMENDADO em contas com muitas mensagens.
-- As funções dashboard_conversations_series / dashboard_response_time filtram messages por conta + intervalo de created_at, e a razão
-- bot × humano (dashboard_ai_analytics) conta por conta + sender_type. Hoje só existe idx_messages_account_conversation
-- (account_id, conversation_id, created_at): serve a consulta por conversa, não o intervalo de datas da conta inteira. Este índice cobre os
-- três usos (account_id + created_at; sender_type/conversation_id/id incluídos para ler só o índice).
--
-- CUSTO: mais um índice em messages (tabela quente de escrita): +1 entrada por mensagem. messages já tem índices por conversa e conta;
-- valide o tamanho/IO antes de ligar numa base muito grande. O app funciona sem ele.
--
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_messages_account_created';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_messages_account_created'::regclass;        -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_messages_account_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_account_created
  ON wacrm.messages (account_id, created_at DESC) INCLUDE (sender_type, conversation_id, id);
