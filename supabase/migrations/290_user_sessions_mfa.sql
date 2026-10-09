-- ============================================================
-- 290_user_sessions_mfa.sql   (PRD 24, item 7 — sessões por dispositivo e 2FA no Perfil)
--
-- O Supabase Auth já guarda tudo (auth.sessions, auth.mfa_factors); o painel do projeto não expõe isso ao usuário e a API pública do
-- GoTrue não lista/encerra UMA sessão específica. Estas funções leem/encerram só as sessões do PRÓPRIO usuário (a rota passa o user_id da
-- sessão validada; nunca um valor do cliente). SECURITY DEFINER, só service_role.
--   wacrm.user_sessions(user)                       dispositivos logados: id, criada, atualizada, user_agent, ip, aal, validade
--   wacrm.revoke_user_session(user, session)        encerra UMA sessão (apaga a linha; os refresh tokens caem em cascata) — só se for do usuário
--   wacrm.revoke_other_user_sessions(user, manter)  encerra todas menos a atual
--   wacrm.user_mfa_factors(user)                    fatores de 2FA: id, tipo, nome, status, criado — NUNCA o segredo
-- Tolerante à versão do GoTrue: colunas lidas por to_jsonb(linha) ->> 'campo' (user_agent/ip/refreshed_at só existem em versões novas).
-- O cadastro e a verificação do TOTP NÃO passam pelo nosso servidor: o front usa supabase.auth.mfa.* com a sessão do próprio usuário
-- (enroll → challenge → verify; unenroll). Requer MFA habilitado no projeto Supabase (Auth → Multi-Factor).
--
-- PRÉ-CHECK:  SELECT to_regclass('auth.sessions'), to_regclass('auth.mfa_factors');       -- não nulos
--             SELECT to_regprocedure('wacrm.user_sessions(uuid)');                          -- NULL na 1ª vez
-- VERIFICAÇÃO: SELECT * FROM wacrm.user_sessions('<user_id>');                              -- (service role / SQL Editor)
-- ORDEM: antes ou depois do deploy (sem a 290 as rotas /api/me/sessions e /api/me/mfa respondem 503). Idempotente.
-- ROLLBACK:   BEGIN; DROP FUNCTION IF EXISTS wacrm.user_sessions(uuid), wacrm.revoke_user_session(uuid, uuid),
--               wacrm.revoke_other_user_sessions(uuid, uuid), wacrm.user_mfa_factors(uuid);
--             DELETE FROM wacrm.schema_migrations WHERE version = '290_user_sessions_mfa'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.sessions') IS NULL OR to_regclass('auth.mfa_factors') IS NULL THEN
    RAISE EXCEPTION '290: faltam auth.sessions/auth.mfa_factors — o projeto Supabase Auth é antigo demais ou o schema auth foi alterado';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.user_sessions(p_user uuid)
RETURNS TABLE (id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, ip text, aal text, not_after timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, auth, public
AS $$
  SELECT s.id,
         s.created_at,
         coalesce((to_jsonb(s) ->> 'refreshed_at')::timestamptz, s.updated_at),
         left(to_jsonb(s) ->> 'user_agent', 300),
         to_jsonb(s) ->> 'ip',
         to_jsonb(s) ->> 'aal',
         (to_jsonb(s) ->> 'not_after')::timestamptz
    FROM auth.sessions s
   WHERE s.user_id = p_user
   ORDER BY coalesce((to_jsonb(s) ->> 'refreshed_at')::timestamptz, s.updated_at) DESC NULLS LAST
   LIMIT 100
$$;

CREATE OR REPLACE FUNCTION wacrm.revoke_user_session(p_user uuid, p_session uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, auth, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  DELETE FROM auth.sessions s WHERE s.id = p_session AND s.user_id = p_user RETURNING s.id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.revoke_other_user_sessions(p_user uuid, p_keep uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, auth, public
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM auth.sessions s WHERE s.user_id = p_user AND (p_keep IS NULL OR s.id <> p_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.user_mfa_factors(p_user uuid)
RETURNS TABLE (id uuid, factor_type text, friendly_name text, status text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, auth, public
AS $$
  SELECT f.id, f.factor_type::text, f.friendly_name, f.status::text, f.created_at
    FROM auth.mfa_factors f
   WHERE f.user_id = p_user
   ORDER BY f.created_at
$$;

REVOKE ALL ON FUNCTION wacrm.user_sessions(uuid), wacrm.revoke_user_session(uuid, uuid), wacrm.revoke_other_user_sessions(uuid, uuid),
  wacrm.user_mfa_factors(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.user_sessions(uuid), wacrm.revoke_user_session(uuid, uuid), wacrm.revoke_other_user_sessions(uuid, uuid),
  wacrm.user_mfa_factors(uuid) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('290_user_sessions_mfa') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
