-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (sem outro comando junto).
--    Junto com outro comando o Supabase abre transação e dá 25001; e desfaz TUDO o que foi junto.
-- ============================================================
-- 215b_knowledge_chunks_embedding_idx.sql   (TASK1-D — RAG vetorial)
--
-- Índice vetorial HNSW (distância de cosseno) dos trechos de conhecimento, usado por wacrm.match_knowledge_chunks (215).
-- CREATE INDEX CONCURRENTLY NÃO roda dentro de transação: aplicar SOZINHO no SQL Editor (um comando, sem BEGIN),
-- DEPOIS da 215. Idempotente. Sem este índice a busca continua correta (varre os trechos da conta pelo índice de conta);
-- ele só passa a importar quando houver muitos trechos. Se o comando for interrompido, ficará um índice INVÁLIDO:
-- apague e refaça (SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   →  DROP INDEX CONCURRENTLY wacrm.idx_knowledge_chunks_embedding_hnsw;).
-- O operador vector_cosine_ops vem da extensão vector (schema `extensions` no Supabase, que já está no search_path
-- padrão do SQL Editor). Se der "operator class does not exist", rode antes, na mesma aba: SET search_path = public, extensions;
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.knowledge_chunks');                    -- não nulo (215)
--             SELECT extversion FROM pg_extension WHERE extname = 'vector';     -- HNSW exige pgvector ≥ 0.5
-- ROLLBACK:   DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_knowledge_chunks_embedding_hnsw;
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw ON wacrm.knowledge_chunks USING hnsw (embedding vector_cosine_ops);
