-- ============================================================
-- 214_knowledge_base_files.sql   (TASK1-B — arquivos de conhecimento dos agentes de IA)
--
-- PROBLEMA: wacrm.knowledge_base_files foi criada em produção SEM migration (ver a 170, A-1.d). O navegador
-- lia e escrevia direto nela (ai-agent-settings), extraindo o texto do PDF no cliente com pdf.js de CDN.
--
-- O QUE FAZ:
--   1. Formaliza a tabela com CREATE TABLE IF NOT EXISTS, compatível com a que existe em produção. Colunas que o código
--      usa hoje (verificado no src): id, account_id, name, content, created_at (responder.ts, agents/service.ts,
--      simulator/ai.ts, ai-agent-settings.tsx). Se a tabela existir sem alguma delas, ABORTA sem mudar nada.
--   2. Acrescenta metadados (ADD COLUMN IF NOT EXISTS, todos opcionais): mime_type, size_bytes, char_count,
--      content_hash (sha256 do texto), created_by, updated_at. Preenche char_count/content_hash das linhas antigas.
--   3. Escrita SÓ pelo servidor (POST/DELETE /api/settings/agents/knowledge, service role): authenticated perde
--      INSERT/UPDATE/DELETE e a policy de escrita da 170 sai. Leitura: membro da conta com ai.agents.view
--      (wacrm.has_perm, migration 241). O app passa a ler pela rota GET; a policy fica como defesa em profundidade.
--   4. Índice (account_id, created_at) para a listagem por conta (tabela pequena: índice comum, sem CONCURRENTLY).
--
-- PRÉ-CHECK (rodar ANTES; confirma o estado live, não confie nos arquivos de migration):
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'wacrm' AND table_name = 'knowledge_base_files' ORDER BY ordinal_position;
--   SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'knowledge_base_files';
--   SELECT to_regprocedure('wacrm.has_perm(text)'), to_regprocedure('wacrm.is_account_member(uuid)');   -- não nulos
--   SELECT count(*), max(char_length(content)) FROM wacrm.knowledge_base_files;
-- VERIFICAÇÃO:
--   SELECT version FROM wacrm.schema_migrations WHERE version = '214_knowledge_base_files';
--   SELECT count(*) FILTER (WHERE char_count IS NULL) FROM wacrm.knowledge_base_files;   -- 0
-- ORDEM: ANTES do deploy (a tela nova lê char_count/size_bytes; a rota grava as colunas novas). Idempotente.
-- ROLLBACK (volta ao estado da 170; as colunas novas podem ficar):
--   DROP POLICY IF EXISTS knowledge_base_files_select ON wacrm.knowledge_base_files;
--   CREATE POLICY knowledge_base_files_select ON wacrm.knowledge_base_files FOR SELECT TO authenticated
--     USING (wacrm.is_account_member(account_id));
--   GRANT INSERT, UPDATE, DELETE ON wacrm.knowledge_base_files TO authenticated;
--   CREATE POLICY knowledge_base_files_write ON wacrm.knowledge_base_files FOR ALL TO authenticated
--     USING (wacrm.is_account_member(account_id, 'agent')) WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
-- ============================================================

BEGIN;

DO $$
DECLARE
  missing text;
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '214: schema wacrm sem accounts — confira o schema vivo';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '214: falta wacrm.has_perm(text) (migration 241) — aplique a 240 e a 241 antes';
  END IF;
  IF to_regprocedure('wacrm.is_account_member(uuid)') IS NULL THEN
    RAISE EXCEPTION '214: falta wacrm.is_account_member(uuid)';
  END IF;
  IF to_regclass('wacrm.knowledge_base_files') IS NOT NULL THEN
    SELECT string_agg(c, ', ') INTO missing
      FROM unnest(ARRAY['id', 'account_id', 'name', 'content', 'created_at']) AS c
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'wacrm' AND table_name = 'knowledge_base_files' AND column_name = c
     );
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION '214: wacrm.knowledge_base_files já existe sem as colunas % — nada foi alterado', missing;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.knowledge_base_files (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  content    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wacrm.knowledge_base_files
  ADD COLUMN IF NOT EXISTS mime_type    text,
  ADD COLUMN IF NOT EXISTS size_bytes   bigint,
  ADD COLUMN IF NOT EXISTS char_count   integer,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS created_by   uuid,
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz;

UPDATE wacrm.knowledge_base_files
   SET char_count   = coalesce(char_length(content), 0),
       content_hash = encode(sha256(convert_to(coalesce(content, ''), 'UTF8')), 'hex')
 WHERE char_count IS NULL OR content_hash IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_base_files_account
  ON wacrm.knowledge_base_files (account_id, created_at DESC);

ALTER TABLE wacrm.knowledge_base_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.knowledge_base_files FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE wacrm.knowledge_base_files TO authenticated;
GRANT ALL ON TABLE wacrm.knowledge_base_files TO service_role;

DROP POLICY IF EXISTS knowledge_base_files_write ON wacrm.knowledge_base_files;
DROP POLICY IF EXISTS knowledge_base_files_select ON wacrm.knowledge_base_files;
CREATE POLICY knowledge_base_files_select ON wacrm.knowledge_base_files FOR SELECT TO authenticated
  USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('ai.agents.view')));

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('214_knowledge_base_files') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
