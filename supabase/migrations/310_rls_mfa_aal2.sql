-- ============================================================
-- 310_rls_mfa_aal2.sql   (2FA obrigatório no BANCO — follow-up do PR de verificação em duas etapas)
--
-- ⚠️ APLICAR PRIMEIRO NO SUPABASE DA V2 E TESTAR LOGIN COM UM USUÁRIO QUE TENHA TOTP (entrar → /login/2fa → código →
--    painel carrega; e um usuário SEM 2FA entra normal). Só depois aplicar em produção.
--
-- PROBLEMA: o servidor já recusa a sessão só com senha (aal1) de quem tem fator TOTP verificado (src/lib/auth/mfa.ts:
-- getUser → 401 mfa_required). Mas várias telas leem e gravam DIRETO do navegador pelo cliente Supabase + RLS, e o RLS
-- não olha o nível de garantia: com a sessão aal1 essas leituras continuavam funcionando.
--
-- O QUE FAZ:
--   1. wacrm.mfa_ok(): true quando o usuário NÃO tem fator TOTP verificado OU quando o JWT da sessão é aal2.
--      STABLE, SECURITY DEFINER (lê auth.mfa_factors por auth.uid() e status 'verified'), search_path fixo (vazio).
--      REVOKE de PUBLIC; EXECUTE só para authenticated.
--   2. Em TODA tabela do schema wacrm com RLS ligada no momento da aplicação, a policy RESTRICTIVE
--        mfa_aal2_required  FOR ALL TO authenticated  USING ((select wacrm.mfa_ok()))  WITH CHECK ((select wacrm.mfa_ok()))
--      Restritiva = soma com as policies que já existem por AND (não dá acesso a ninguém, só tira de quem está em aal1 com
--      fator). `(select …)` faz o Postgres avaliar a função UMA vez por comando (initplan), não por linha.
--   Não afeta: service_role (BYPASSRLS), anon (webchat /w/[token], login), funções SECURITY DEFINER do dono, quem não tem
--   fator, quem está em aal2. Realtime respeita o RLS: assinatura aal1 de quem tem fator deixa de receber eventos.
--   Tabela nova criada DEPOIS desta migration não recebe a policy sozinha: a migration que ligar a RLS chama
--   SELECT wacrm.apply_mfa_policy('wacrm.<tabela>'::regclass);  (regra no supabase/migrations/_MODELO.md; o teste
--   src/lib/security/mfa-rls.sql.test.ts falha se uma tabela do wacrm com RLS ficar sem a policy).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('auth.mfa_factors');                                                  -- não nulo
--   SELECT proname FROM pg_proc WHERE pronamespace = 'auth'::regnamespace AND proname IN ('jwt', 'uid');   -- 2 linhas
--   -- índice por user_id em auth.mfa_factors (a função consulta por auth.uid()):
--   SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'auth' AND tablename = 'mfa_factors' AND indexdef ILIKE '%(user_id%';
--   -- tabelas que vão receber a policy (lista exata do banco vivo):
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'wacrm' AND c.relkind IN ('r', 'p') AND c.relrowsecurity ORDER BY 1;
--   -- quem tem 2FA hoje (essas pessoas precisam entrar com o código depois desta migration):
--   SELECT count(DISTINCT user_id) FROM auth.mfa_factors WHERE status = 'verified' AND factor_type = 'totp';
-- VERIFICAÇÃO:
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'wacrm' AND policyname = 'mfa_aal2_required';   -- = nº de tabelas
--   SELECT version FROM wacrm.schema_migrations WHERE version = '310_rls_mfa_aal2';
-- ORDEM: DEPOIS do deploy do PR de 2FA (passo /login/2fa no ar), senão quem já tem fator fica sem o caminho para aal2.
-- ROLLBACK (só o que esta migration criou):
--   DO $$ DECLARE t text; BEGIN
--     FOR t IN SELECT tablename FROM pg_policies WHERE schemaname = 'wacrm' AND policyname = 'mfa_aal2_required' LOOP
--       EXECUTE format('DROP POLICY IF EXISTS mfa_aal2_required ON wacrm.%I', t);
--     END LOOP; END $$;
--   DROP FUNCTION IF EXISTS wacrm.apply_mfa_policy(regclass);
--   DROP FUNCTION IF EXISTS wacrm.mfa_ok();
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.mfa_factors') IS NULL THEN
    RAISE EXCEPTION '310: falta auth.mfa_factors (Supabase Auth com MFA) — confira o projeto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'auth' AND p.proname = 'jwt')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'auth' AND p.proname = 'uid') THEN
    RAISE EXCEPTION '310: faltam auth.jwt()/auth.uid() — confira o projeto';
  END IF;
  IF to_regnamespace('wacrm') IS NULL THEN
    RAISE EXCEPTION '310: schema wacrm não existe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'auth' AND tablename = 'mfa_factors' AND indexdef ILIKE '%(user_id%'
  ) THEN
    RAISE NOTICE '310: auth.mfa_factors sem índice começando por user_id — a função fica correta, mas confira o desempenho';
  END IF;
END $$;

-- 1) a regra
CREATE OR REPLACE FUNCTION wacrm.mfa_ok()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      OR NOT EXISTS (
        SELECT 1
          FROM auth.mfa_factors f
         WHERE f.user_id = auth.uid()
           AND f.status::text = 'verified'
           AND f.factor_type::text = 'totp'
      )
$$;
REVOKE ALL ON FUNCTION wacrm.mfa_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.mfa_ok() TO authenticated;

-- 2) aplicador idempotente (usado aqui e pelas próximas migrations que ligarem RLS numa tabela do wacrm)
CREATE OR REPLACE FUNCTION wacrm.apply_mfa_policy(p_table regclass)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_schema text;
  v_name text;
BEGIN
  SELECT n.nspname, c.relname INTO v_schema, v_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_table;
  IF v_schema IS DISTINCT FROM 'wacrm' THEN
    RAISE EXCEPTION 'apply_mfa_policy: só tabelas do schema wacrm (recebeu %)', p_table;
  END IF;
  EXECUTE format('DROP POLICY IF EXISTS mfa_aal2_required ON wacrm.%I', v_name);
  EXECUTE format(
    'CREATE POLICY mfa_aal2_required ON wacrm.%I AS RESTRICTIVE FOR ALL TO authenticated '
    'USING ((select wacrm.mfa_ok())) WITH CHECK ((select wacrm.mfa_ok()))',
    v_name
  );
END $$;
REVOKE ALL ON FUNCTION wacrm.apply_mfa_policy(regclass) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'wacrm'
       AND c.relkind IN ('r', 'p')
       AND c.relrowsecurity
     ORDER BY 1
  LOOP
    PERFORM wacrm.apply_mfa_policy(t);
  END LOOP;
END $$;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('310_rls_mfa_aal2') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
