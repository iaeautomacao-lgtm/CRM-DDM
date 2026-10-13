-- ============================================================
-- 352_pipelines_delete_owner_only.sql   (decisão do dono 13/10: excluir funil em definitivo só o proprietário)
--
-- A 340 cria a permissão pipelines.delete (ownerOnly) e põe a policy de DELETE de pipelines nela. A 348 (RLS fase 3,
-- escrita) roda DEPOIS e recria pipelines_delete com pipelines.manage, o que devolveria a exclusão ao admin.
-- Esta migration vem depois das duas e deixa a regra final: DELETE em wacrm.pipelines só com has_perm('pipelines.delete').
-- Nada mais muda (insert/update de funis e as etapas seguem com pipelines.manage, como na 348).
--
-- PRÉ-CHECK:  SELECT key FROM wacrm.permission_catalog WHERE key = 'pipelines.delete';          -- 1 linha (vem da 340; sem ela ABORTA)
--             SELECT policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'pipelines' AND cmd = 'DELETE';
-- VERIFICAÇÃO: o qual de pipelines_delete cita has_perm('pipelines.delete'); como admin, DELETE em wacrm.pipelines → 0 linhas.
-- ORDEM: depois da 340 e da 348; antes ou depois do deploy (o app já esconde o botão sem pipelines.delete). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS pipelines_delete ON wacrm.pipelines;
--             CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.manage')));
--             DELETE FROM wacrm.schema_migrations WHERE version = '352_pipelines_delete_owner_only';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wacrm.permission_catalog WHERE key = 'pipelines.delete') THEN
    RAISE EXCEPTION '352: falta a permissão pipelines.delete (rode antes a 340_pipeline_archive). Nada foi alterado.';
  END IF;
END $$;

DROP POLICY IF EXISTS pipelines_delete ON wacrm.pipelines;
CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.delete'))
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('352_pipelines_delete_owner_only') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
