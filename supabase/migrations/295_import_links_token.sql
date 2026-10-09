-- ============================================================
-- 295_import_links_token.sql   (PRD 11 — A15)
-- O que faz: wacrm.disp_import_contacts.import_token (nullable). O front manda o mesmo import_token em todos os blocos de uma
-- importação; o bloco 0 passa a apagar só os vínculos de OUTRA importação (token diferente ou NULL = legado). Assim reenviar o
-- bloco 0 depois dos seguintes não desfaz contatos já vinculados. Sem a coluna o servidor ignora o token (comportamento antigo).
-- PRÉ-CHECK: SELECT to_regclass('wacrm.disp_import_contacts');   -- não nulo
-- VERIFICAÇÃO: SELECT column_name FROM information_schema.columns
--               WHERE table_schema='wacrm' AND table_name='disp_import_contacts' AND column_name='import_token';   -- 1 linha
-- ORDEM: pode ser aplicada antes ou depois do deploy. Sem índice: a limpeza filtra por (draft_id|campaign_id), já indexados.
-- ROLLBACK: ALTER TABLE wacrm.disp_import_contacts DROP COLUMN IF EXISTS import_token;
-- ============================================================
BEGIN;

DO $$ BEGIN
  IF to_regclass('wacrm.disp_import_contacts') IS NULL THEN
    RAISE EXCEPTION '295: falta wacrm.disp_import_contacts (migration 132)';
  END IF;
END $$;

ALTER TABLE wacrm.disp_import_contacts ADD COLUMN IF NOT EXISTS import_token text;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('295_import_links_token') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
