-- ============================================================
-- 363_perf_rls_membership_initplan.sql   (desempenho — RLS de leitura: "é membro da conta?" avaliada UMA vez por consulta, não por linha)
--
-- PROBLEMA: as policies de SELECT de deals, disp_message_queue e campaign_metrics (305/340) têm `wacrm.is_account_member(account_id)`. A função é
-- SECURITY DEFINER (não é "inlinada") e recebe o account_id DA LINHA: o Postgres a chama uma vez POR LINHA lida (cada chamada é uma consulta a
-- profiles). Numa leitura de milhares de negócios (quadro do funil, painel) isso vira segundos. A parte de permissão (`(SELECT wacrm.has_perm(..))`)
-- já era "initplan" (uma vez por consulta) desde a 305.
--
-- O QUE FAZ: cria wacrm.my_account_ids() (STABLE, SECURITY DEFINER) = contas em que o usuário logado é membro (mesma regra do is_account_member de nível
-- mínimo "viewer": perfil do usuário na conta com papel conhecido) e troca, NAS 3 policies, `is_account_member(account_id)` por
-- `account_id = ANY ((SELECT wacrm.my_account_ids()))` — avaliado uma vez por consulta. O resto da expressão viva (has_perm, EXISTS de funil ativo…) é
-- MANTIDO como está: a troca é textual e só acontece se a expressão tiver exatamente UMA ocorrência. Mesmo resultado para todo usuário; só muda o plano.
--
-- NÃO MUDA regra de acesso: quem lia, lê o mesmo; quem não lia, não lê (inclusive outra conta e perfil sem papel).
--
-- FORA: messages_select (depende de conversations; confira com perf-explain.sql [6] antes de mexer), contacts/conversations (leitura por equipe, 140).
--
-- PRÉ-CHECK:  SELECT to_regprocedure('wacrm.is_account_member(uuid, wacrm.account_role_enum)') IS NOT NULL OR to_regprocedure('wacrm.is_account_member(uuid, public.account_role_enum)') IS NOT NULL;  -- true
--             SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND policyname IN ('deals_select','disp_message_queue_select','campaign_metrics_select');  -- 3 linhas, cada qual com is_account_member(account_id)
-- VERIFICAÇÃO: as 3 policies passam a conter my_account_ids; logado como membro: SELECT count(*) FROM wacrm.deals; → igual a antes; logado em outra conta → 0 das contas alheias.
--              Repita o EXPLAIN [1] de prd-v2/perf-explain.sql: some o "SubPlan" por linha e o tempo cai.
-- ORDEM: depois da 305 e da 340. Antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DO $$ DECLARE r record; q text; BEGIN
--               FOR r IN SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND policyname IN ('deals_select','disp_message_queue_select','campaign_metrics_select') LOOP
--                 q := replace(r.qual, 'account_id = ANY (( SELECT wacrm.my_account_ids() AS my_account_ids)::uuid[])', 'wacrm.is_account_member(account_id)');
--                 EXECUTE format('ALTER POLICY %I ON wacrm.%I USING (%s)', r.policyname, r.tablename, q);
--               END LOOP;
--             END $$;
--             DROP FUNCTION IF EXISTS wacrm.my_account_ids();
--             DELETE FROM wacrm.schema_migrations WHERE version = '363_perf_rls_membership_initplan';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_pol text;
  v_qual text;
BEGIN
  IF to_regclass('wacrm.profiles') IS NULL THEN
    RAISE EXCEPTION '363: falta wacrm.profiles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name IN ('account_role')) THEN
    RAISE EXCEPTION '363: wacrm.profiles não tem account_role — confira o schema vivo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '363: falta wacrm.is_account_member';
  END IF;
  FOREACH v_pol IN ARRAY ARRAY['deals_select', 'disp_message_queue_select', 'campaign_metrics_select'] LOOP
    SELECT qual INTO v_qual FROM pg_policies WHERE schemaname = 'wacrm' AND policyname = v_pol;
    IF v_qual IS NULL THEN
      RAISE EXCEPTION '363: policy % não existe em wacrm — confira o schema vivo', v_pol;
    END IF;
    IF v_qual NOT LIKE '%my_account_ids%' AND v_qual !~ 'is_account_member\(account_id\)' THEN
      RAISE EXCEPTION '363: a policy % não tem is_account_member(account_id) (expressão editada à mão): %', v_pol, v_qual;
    END IF;
  END LOOP;
END $$;

-- Contas em que o usuário logado é membro (mesma regra de is_account_member(conta) com nível mínimo viewer: perfil do usuário na conta com papel conhecido).
CREATE OR REPLACE FUNCTION wacrm.my_account_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT p.account_id), '{}'::uuid[])
    FROM wacrm.profiles p
   WHERE p.user_id = (SELECT auth.uid())
     AND p.account_id IS NOT NULL
     AND p.account_role::text IN ('owner', 'admin', 'supervisor', 'agent', 'viewer')
$$;
REVOKE ALL ON FUNCTION wacrm.my_account_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.my_account_ids() TO authenticated, service_role;

DO $$
DECLARE
  r record;
  v_new text;
  v_old constant text := 'wacrm.is_account_member(account_id)';
  v_with constant text := 'account_id = ANY ((SELECT wacrm.my_account_ids())::uuid[])';
  v_found integer;
  v_qual text;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual FROM pg_policies
     WHERE schemaname = 'wacrm' AND policyname IN ('deals_select', 'disp_message_queue_select', 'campaign_metrics_select')
  LOOP
    IF r.qual LIKE '%my_account_ids%' THEN CONTINUE; END IF;   -- já ajustada
    -- pg_policies.qual mostra a função com ou sem o prefixo do schema, conforme o search_path: normaliza antes de contar.
    v_qual := regexp_replace(r.qual, '(wacrm\.)?is_account_member\(account_id\)', v_old, 'g');
    v_found := (length(v_qual) - length(replace(v_qual, v_old, ''))) / length(v_old);
    IF v_found <> 1 THEN
      RAISE EXCEPTION '363: % tem % ocorrência(s) de is_account_member(account_id) (esperado 1) — nada foi alterado: %', r.policyname, v_found, r.qual;
    END IF;
    v_new := replace(v_qual, v_old, v_with);
    EXECUTE format('ALTER POLICY %I ON wacrm.%I USING (%s)', r.policyname, r.tablename, v_new);
  END LOOP;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('363_perf_rls_membership_initplan') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
