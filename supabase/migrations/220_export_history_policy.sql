-- ============================================================
-- 220_export_history_policy.sql   (PRD 14, 14.6 — SG-17: exportações só para quem pode gerar)
--
-- PROBLEMA: gerar e listar exportações exige supervisor+ na API (relatorios/exports → `reports.export`), mas a policy de
-- export_history (055) e a do Storage do bucket `relatorio-exports` liberam leitura a QUALQUER membro da conta. Um operador
-- (ou visualizador) consultava export_history e baixava, por URL assinada, planilhas com nome, telefone e agente de TODOS
-- os contatos — material que a tela e a API não lhe dão.
--
-- O QUE FAZ (mesmo critério da API: permissão `reports.export` = supervisor+, via wacrm.has_perm da migration 241):
--   1. export_history_select: membro da conta E com reports.export.
--   2. Storage (storage.objects, bucket relatorio-exports): a policy "account members read exports" é trocada por
--      "supervisors read exports" (mesma regra de pasta {account_id}/…, mais reports.export).
--   3. get_export_history(uuid, text): mesma assinatura e colunas; passa a devolver vazio para quem não tem reports.export
--      (nem storage_path vaza para papéis baixos).
-- Para supervisor, admin e proprietário NADA muda. Não altera colunas nem o que cada exportação traz.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.export_history'), to_regprocedure('wacrm.get_export_history(uuid,text)'), to_regprocedure('wacrm.has_perm(text)');  -- não nulos (055, 241)
--   SELECT policyname, cmd FROM pg_policies WHERE (schemaname,tablename) IN (('wacrm','export_history'),('storage','objects')) AND (policyname ILIKE '%export%');
--   -- Se existirem OUTRAS policies de SELECT que liberem o bucket a todos, esta migration NÃO as remove: confira a lista.
-- VERIFICAÇÃO (como operador logado no app): GET /rest/v1/export_history → []; como supervisor → as exportações da conta.
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK (reabre a leitura a todo membro — só em emergência):
--   BEGIN;
--   DROP POLICY IF EXISTS export_history_select ON wacrm.export_history;
--   CREATE POLICY export_history_select ON wacrm.export_history FOR SELECT USING (wacrm.is_account_member(account_id));
--   DROP POLICY IF EXISTS "supervisors read exports" ON storage.objects;
--   CREATE POLICY "account members read exports" ON storage.objects FOR SELECT USING (bucket_id = 'relatorio-exports'
--     AND EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND (storage.foldername(name))[1] = p.account_id::text));
--   -- e recrie get_export_history sem a condição has_perm (corpo da migration 055)
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.export_history') IS NULL THEN
    RAISE EXCEPTION '220: falta wacrm.export_history (migration 055)';
  END IF;
  IF to_regprocedure('wacrm.get_export_history(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '220: falta wacrm.get_export_history(uuid,text) (migration 055)';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '220: falta wacrm.has_perm(text) (migration 241) — aplique a 240 e a 241 antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wacrm.permission_catalog WHERE key = 'reports.export') THEN
    RAISE EXCEPTION '220: permissão reports.export fora do catálogo (migration 240)';
  END IF;
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION '220: falta storage.objects';
  END IF;
END $$;

-- 1) tabela
DROP POLICY IF EXISTS export_history_select ON wacrm.export_history;
CREATE POLICY export_history_select ON wacrm.export_history FOR SELECT
  USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('reports.export')));

-- 2) Storage (pasta {account_id}/… como na 055, agora só com reports.export)
DROP POLICY IF EXISTS "account members read exports" ON storage.objects;
DROP POLICY IF EXISTS "supervisors read exports" ON storage.objects;
CREATE POLICY "supervisors read exports" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'relatorio-exports'
    AND (SELECT wacrm.has_perm('reports.export'))
    AND EXISTS (
      SELECT 1 FROM wacrm.profiles p
       WHERE p.user_id = auth.uid()
         AND (storage.foldername(name))[1] = p.account_id::text
    )
  );

-- 3) RPC de listagem: mesma assinatura/colunas da 055; vazio sem reports.export (storage_path não vaza)
CREATE OR REPLACE FUNCTION wacrm.get_export_history(
  p_account_id UUID,
  p_search     TEXT DEFAULT NULL
)
RETURNS TABLE (
  id           UUID,
  user_name    TEXT,
  export_type  TEXT,
  description  TEXT,
  period_from  TIMESTAMPTZ,
  period_to    TIMESTAMPTZ,
  file_name    TEXT,
  storage_path TEXT,
  file_size    BIGINT,
  status       TEXT,
  created_at   TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  SELECT
    id, user_name, export_type, description,
    period_from, period_to, file_name, storage_path,
    file_size, status, created_at
  FROM wacrm.export_history
  WHERE account_id = p_account_id
    AND is_account_member(p_account_id)
    AND wacrm.has_perm('reports.export')
    AND (
      p_search IS NULL
      OR description ILIKE '%' || p_search || '%'
      OR user_name ILIKE '%' || p_search || '%'
    )
  ORDER BY created_at DESC
  LIMIT 200;
$$;

ALTER FUNCTION wacrm.get_export_history(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_export_history(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_export_history(UUID, TEXT) TO authenticated;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('220_export_history_policy') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
