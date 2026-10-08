-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (sem outro comando junto).
--    Junto com outro comando o Supabase abre transação e dá 25001; e desfaz TUDO o que foi junto.
-- ============================================================
-- 241b_profiles_role_id_idx.sql   (PRD 20, fase 20.2)
--
-- Índice de profiles.role_id (verificar "papel em uso" e a FK ON DELETE RESTRICT sem varrer a tabela).
-- CREATE INDEX CONCURRENTLY NÃO roda dentro de transação: aplicar SOZINHO no SQL Editor (um comando, sem BEGIN),
-- DEPOIS da 240. Idempotente. Se o comando for interrompido, ficará um índice INVÁLIDO: apague e refaça
--   (SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;  →  DROP INDEX CONCURRENTLY wacrm.idx_profiles_role_id;).
--
-- PRÉ-CHECK:  SELECT count(*) FROM information_schema.columns
--               WHERE table_schema='wacrm' AND table_name='profiles' AND column_name='role_id';   -- 1 (240)
-- ROLLBACK:   DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_profiles_role_id;
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_role_id ON wacrm.profiles (role_id);
