-- ============================================================
-- 306_profiles_email_hidden.sql   (RLS fase 2, §8 item 3 — profiles.email escondido de quem não tem members.view_emails)
--
-- Hoje QUALQUER membro lê o e-mail de TODOS os membros da conta direto pelo PostgREST (a policy de profiles é só de membership), embora
-- members.view_emails seja admin+ no catálogo (a rota /api/account/members já mascara; o banco não). Decisão do dono (09/10): esconder.
-- Como (coluna, não visão — as policies de linha e todo select("user_id, full_name, …") continuam iguais):
--   1. REVOKE SELECT na tabela e GRANT SELECT só nas colunas SEM email para `authenticated` (service_role mantém tudo; as rotas de servidor que
--      precisam do e-mail leem com o service role e mascaram por members.view_emails, como /api/account/members).
--   2. wacrm.visible_member_email(uuid): o e-mail do membro SÓ para ele mesmo, para quem tem members.view_emails na MESMA conta, ou para o service
--      role; NULL para os demais (SECURITY DEFINER).
--   3. wacrm.dashboard_ai_analytics() (293, SECURITY INVOKER) lia p.email para o nome do operador: passa a usar visible_member_email (mesmo resultado para
--      quem pode ver; sem ele cairia em "permission denied for column email" no Dashboard).
--
-- ATENÇÃO (quem mexe em profiles daqui para frente):
--   - `select("*")` de profiles pelo cliente do usuário (navegador ou createClient do servidor) FALHA com "permission denied for column email": use colunas
--     explícitas (o código desta entrega já foi ajustado: getCurrentAccount, Inbox, chat interno, funis, dashboard, prompt-versions).
--   - coluna NOVA de profiles criada por migration futura NÃO é legível pelo cliente do usuário até um `GRANT SELECT (<coluna>) ON wacrm.profiles TO authenticated`.
--   - o e-mail da PRÓPRIA pessoa vem da sessão do Supabase Auth (use-auth), não de profiles.email.
--
-- PRÉ-CHECK:  SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name = 'email';   -- 1 linha
--             SELECT to_regprocedure('wacrm.has_perm(text)'), (SELECT count(*) FROM wacrm.permission_catalog WHERE key = 'members.view_emails');         -- não nulo, 1
--             SELECT grantee, privilege_type FROM information_schema.table_privileges WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND grantee = 'authenticated';  -- SELECT de tabela (vai virar por coluna)
-- ORDEM: depois da 241 (has_perm) e da 293. ⚠️ FAZER O DEPLOY do código novo ANTES e aplicar esta migration DEPOIS do deploy: o código desta entrega (sem select("*") de
--   profiles nem e-mail de agente) tolera a coluna ainda legível, mas o código ANTIGO quebra (Inbox, Dashboard, funis, conta) com "permission denied for column email"
--   assim que a coluna some. Idempotente.
-- ROLLBACK:   BEGIN;
--             GRANT SELECT ON wacrm.profiles TO authenticated;
--             DO $$ DECLARE d text; BEGIN
--               IF to_regprocedure('wacrm.dashboard_ai_analytics()') IS NOT NULL THEN
--                 SELECT pg_get_functiondef(to_regprocedure('wacrm.dashboard_ai_analytics()')) INTO d;
--                 EXECUTE replace(d, 'NULLIF(wacrm.visible_member_email(p.user_id), '''')', 'NULLIF(p.email, '''')');
--               END IF;
--             END $$;
--             DROP FUNCTION IF EXISTS wacrm.visible_member_email(uuid);
--             DELETE FROM wacrm.schema_migrations WHERE version = '306_profiles_email_hidden';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.profiles') IS NULL THEN
    RAISE EXCEPTION '306: falta wacrm.profiles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name = 'email') THEN
    RAISE EXCEPTION '306: wacrm.profiles não tem a coluna email — confira o schema vivo';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL OR to_regprocedure('wacrm.current_account_id()') IS NULL THEN
    RAISE EXCEPTION '306: faltam wacrm.has_perm(text) / wacrm.current_account_id() (migrations 241 / 170)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wacrm.permission_catalog WHERE key = 'members.view_emails') THEN
    RAISE EXCEPTION '306: members.view_emails fora do catálogo (migration 240)';
  END IF;
END $$;

-- 1) e-mail visível: o próprio, quem tem members.view_emails na mesma conta, ou o service role
CREATE OR REPLACE FUNCTION wacrm.visible_member_email(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.email
    FROM wacrm.profiles p
   WHERE p.user_id = p_user
     AND (
       p.user_id = (SELECT auth.uid())
       OR coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                   nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') = 'service_role'
       OR (p.account_id = (SELECT wacrm.current_account_id()) AND (SELECT wacrm.has_perm('members.view_emails')))
     )
$$;
REVOKE ALL ON FUNCTION wacrm.visible_member_email(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.visible_member_email(uuid) TO authenticated, service_role;

-- 2) o Dashboard (293, SECURITY INVOKER) lia p.email: passa pela função (mesmo resultado para quem pode ver)
DO $$
DECLARE
  v_def text;
  v_old constant text := 'NULLIF(p.email, '''')';
  v_new constant text := 'NULLIF(wacrm.visible_member_email(p.user_id), '''')';
  v_found integer;
BEGIN
  IF to_regprocedure('wacrm.dashboard_ai_analytics()') IS NULL THEN
    RAISE NOTICE '306: dashboard_ai_analytics() não existe (293 não aplicada) — nada a ajustar';
    RETURN;
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('wacrm.dashboard_ai_analytics()'));
  IF position('visible_member_email' IN v_def) > 0 THEN
    RETURN; -- já ajustada
  END IF;
  v_found := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_found <> 1 THEN
    RAISE EXCEPTION '306: dashboard_ai_analytics() diferente da esperada (% ocorrência(s) de %, esperado 1) — nada foi alterado', v_found, v_old;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;

-- 3) coluna escondida: SELECT por coluna (sem email) para authenticated; service_role mantém tudo
REVOKE SELECT ON wacrm.profiles FROM PUBLIC, anon, authenticated;
DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name <> 'email';
  EXECUTE format('GRANT SELECT (%s) ON wacrm.profiles TO authenticated', v_cols);
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('306_profiles_email_hidden') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
