-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 335b — índice parcial das marcas de telefone inválido (migration 335). O startCampaign lê só os contatos MARCADOS da conta e cruza com o
-- público; sem o índice essa leitura varre contacts. Parcial: contém só os marcados, então é minúsculo e quase não custa escrita.
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_contacts_phone_invalid';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_contacts_phone_invalid'::regclass;        -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_contacts_phone_invalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_phone_invalid
  ON wacrm.contacts (account_id, id)
  WHERE phone_invalid_at IS NOT NULL;
