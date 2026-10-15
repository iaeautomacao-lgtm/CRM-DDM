-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (sem outro comando junto).
-- 372b — índice parcial da carteira fixa (contatos de um atendente). Só entra quem tem dono (a maioria dos contatos não tem): índice pequeno.
-- Serve a "contatos da carteira de fulano" (fase 2 da carteira) e ao ON DELETE SET NULL de usuário removido.
--
-- PRÉ-CHECK: SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='contacts' AND column_name='owner_user_id';   -- 1 linha (372)
--            SELECT indexname FROM pg_indexes WHERE schemaname = 'wacrm' AND tablename = 'contacts' AND indexname = 'idx_contacts_owner';              -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_contacts_owner'::regclass;                                                -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_contacts_owner;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_owner ON wacrm.contacts (account_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
