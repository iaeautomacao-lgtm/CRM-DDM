-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (sem outro comando junto).
-- 314b — índice da busca de contato por telefone (auditoria de backend B-13; usado por wacrm.find_contacts_by_phone_suffix, 314).
-- A busca roda a cada mensagem recebida; antes era `phone LIKE '%sufixo'` (sem índice possível: varria a conta).
-- CUSTO: +1 entrada por contato (8 caracteres + account_id). Com CONCURRENTLY não bloqueia escrita, mas leva o tempo de
-- uma leitura completa de contacts: rode fora do pico.
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_contacts_account_phone_suffix8';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_contacts_account_phone_suffix8'::regclass;       -- true
--            (false = a criação falhou no meio: DROP INDEX CONCURRENTLY e rode de novo)
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_contacts_account_phone_suffix8;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_account_phone_suffix8
  ON wacrm.contacts (account_id, (right(phone_normalized, 8)));
