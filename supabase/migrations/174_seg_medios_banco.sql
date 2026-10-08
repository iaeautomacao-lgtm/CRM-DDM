-- ============================================================
-- 174_seg_medios_banco.sql
--
-- Auditoria de segurança (docs/prd/09-auditoria-seguranca.md): A-9 (resto da
-- 170), M-12.
--
-- 1) RPCs SECURITY DEFINER com `SET search_path = ''` (nomes qualificados):
--    - wacrm.move_stale_deals        : só service_role (já era na 170).
--    - wacrm.run_all_deal_aging_rules: navegador (pipelines, deals-settings,
--      pipeline-automations). Passa a exigir papel AGENT+ na conta (antes:
--      qualquer membro, inclusive viewer, movia deals). Só move deals da conta.
--    - wacrm.seed_tabulacao_tags     : só service_role/trigger; body já usa só
--      nomes qualificados (wacrm.tags) → search_path vazio é seguro.
--    - wacrm.increment_unread_count  : só service_role (webhooks/ingest).
--    A 170 já fechou os GRANTs e a checagem de conta; aqui só endurece o
--    search_path (era `wacrm, public`) e o papel mínimo do run_all.
--
-- 2) M-12:
--    - wacrm.deal_aging_rules: leitura por membro; escrita (INSERT/UPDATE/
--      DELETE) só admin/owner. Antes: policy FOR ALL por qualquer membro.
--    - wacrm.internal_messages: o destinatário só pode alterar `read_at`
--      (GRANT de coluna) e a policy exige ser membro da conta. Antes podia
--      reescrever `content`/`sender_id`.
--
-- PRÉ-CHECK (rodar ANTES; confirma o estado live — os arquivos de migration
-- podem não refletir produção):
--   SELECT p.proname, p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args,
--          (SELECT array_agg(a.grantee::regrole::text || ':' || a.privilege_type)
--             FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS acl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'wacrm'
--      AND p.proname IN ('move_stale_deals','run_all_deal_aging_rules','seed_tabulacao_tags','increment_unread_count');
--   SELECT pg_get_functiondef('wacrm.run_all_deal_aging_rules(uuid)'::regprocedure);
--   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--    WHERE schemaname = 'wacrm' AND tablename IN ('deal_aging_rules','internal_messages');
--   SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges
--    WHERE table_schema = 'wacrm' AND table_name = 'internal_messages' AND grantee = 'authenticated';
--   SELECT enum_range(NULL::wacrm.account_role_enum);   -- confirma 'agent' e 'admin'
--
-- ORDEM: pode ser aplicada ANTES ou DEPOIS do deploy (o código não muda para
-- estas tabelas/RPCs). Efeito visível: viewer deixa de disparar o
-- run_all_deal_aging_rules ao abrir /pipelines (a página ignora o erro) e
-- deixa de criar/editar/apagar regras de envelhecimento.
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.is_account_member(uuid, wacrm.account_role_enum)') IS NULL THEN
    RAISE EXCEPTION 'wacrm.is_account_member(uuid, account_role_enum) não existe (migration 017)';
  END IF;
END $$;

-- ---------- 1) RPCs ----------
CREATE OR REPLACE FUNCTION wacrm.move_stale_deals(
  p_source_stage_id uuid,
  p_target_stage_id uuid,
  p_days_limit int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated_count int;
BEGIN
  UPDATE wacrm.deals
  SET stage_id = p_target_stage_id,
      updated_at = pg_catalog.now()
  WHERE stage_id = p_source_stage_id
    AND status = 'open'
    AND updated_at < pg_catalog.now() - (p_days_limit || ' days')::interval;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.move_stale_deals(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.move_stale_deals(uuid, uuid, int) TO service_role;

CREATE OR REPLACE FUNCTION wacrm.run_all_deal_aging_rules(p_account_id uuid)
RETURNS TABLE (
  rule_id uuid,
  moved_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rule record;
  v_moved int;
BEGIN
  -- Só o navegador chama (auth.uid() presente): precisa ser agent+ NESTA conta.
  IF NOT wacrm.is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'Acesso negado à conta' USING ERRCODE = '42501';
  END IF;

  FOR v_rule IN
    SELECT r.id, r.source_stage_id, r.target_stage_id, r.days_limit
    FROM wacrm.deal_aging_rules r
    WHERE r.account_id = p_account_id
  LOOP
    UPDATE wacrm.deals d
    SET stage_id = v_rule.target_stage_id,
        updated_at = pg_catalog.now()
    WHERE d.account_id = p_account_id
      AND d.stage_id = v_rule.source_stage_id
      AND d.status = 'open'
      AND d.updated_at < pg_catalog.now() - (v_rule.days_limit || ' days')::interval;

    GET DIAGNOSTICS v_moved = ROW_COUNT;

    rule_id := v_rule.id;
    moved_count := v_moved;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.run_all_deal_aging_rules(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.run_all_deal_aging_rules(uuid) TO authenticated, service_role;

-- Corpo usa só nomes qualificados (wacrm.tags) e nativos: search_path vazio é seguro.
ALTER FUNCTION wacrm.seed_tabulacao_tags(uuid, uuid) SET search_path = '';
REVOKE ALL ON FUNCTION wacrm.seed_tabulacao_tags(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.seed_tabulacao_tags(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION wacrm.increment_unread_count(conversation_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE wacrm.conversations
  SET unread_count = unread_count + 1
  WHERE id = $1;
$$;
REVOKE ALL ON FUNCTION wacrm.increment_unread_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.increment_unread_count(uuid) TO service_role;

-- ---------- 2) M-12: deal_aging_rules ----------
DO $$
BEGIN
  IF to_regclass('wacrm.deal_aging_rules') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE wacrm.deal_aging_rules ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage deal aging rules" ON wacrm.deal_aging_rules';
    EXECUTE 'DROP POLICY IF EXISTS deal_aging_rules_select ON wacrm.deal_aging_rules';
    EXECUTE 'DROP POLICY IF EXISTS deal_aging_rules_write ON wacrm.deal_aging_rules';
    EXECUTE 'CREATE POLICY deal_aging_rules_select ON wacrm.deal_aging_rules
      FOR SELECT TO authenticated
      USING (wacrm.is_account_member(account_id))';
    EXECUTE 'CREATE POLICY deal_aging_rules_write ON wacrm.deal_aging_rules
      FOR ALL TO authenticated
      USING (wacrm.is_account_member(account_id, ''admin''))
      WITH CHECK (wacrm.is_account_member(account_id, ''admin''))';
    EXECUTE 'REVOKE ALL ON wacrm.deal_aging_rules FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.deal_aging_rules TO authenticated';
    EXECUTE 'GRANT ALL ON wacrm.deal_aging_rules TO service_role';
  END IF;
END $$;

-- ---------- 3) M-12: internal_messages ----------
DO $$
BEGIN
  IF to_regclass('wacrm.internal_messages') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS internal_messages_update ON wacrm.internal_messages';
    EXECUTE 'CREATE POLICY internal_messages_update ON wacrm.internal_messages
      FOR UPDATE TO authenticated
      USING (auth.uid() = recipient_id AND wacrm.is_account_member(account_id))
      WITH CHECK (auth.uid() = recipient_id AND wacrm.is_account_member(account_id))';
    -- Destinatário marca como lida; nada além disso.
    EXECUTE 'REVOKE UPDATE ON wacrm.internal_messages FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT UPDATE (read_at) ON wacrm.internal_messages TO authenticated';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
