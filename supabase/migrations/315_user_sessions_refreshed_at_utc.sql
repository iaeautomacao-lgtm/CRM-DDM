-- ============================================================
-- 315_user_sessions_refreshed_at_utc.sql   (correção da 290 — refreshed_at lido como UTC)
--
-- PROBLEMA: no GoTrue, auth.sessions.refreshed_at é `timestamp` SEM fuso, gravado em UTC. A 290 fazia
--   (to_jsonb(s) ->> 'refreshed_at')::timestamptz, que interpreta o texto no fuso da SESSÃO do banco. No Supabase a sessão é
--   UTC e o erro não aparece; com outro fuso (SQL Editor, pooler, conexão com TimeZone) a "última atividade" saía deslocada.
-- O QUE FAZ:
--   1. wacrm.gotrue_ts(text): converte o texto de um campo do GoTrue para timestamptz. Com fuso no texto (versão em que a
--      coluna é timestamptz: to_jsonb devolve '…-03:00'/'…+00:00'/'…Z') usa o fuso do texto; sem fuso, lê como UTC.
--      Interna (só as funções SECURITY DEFINER a usam).
--   2. Recria wacrm.user_sessions(uuid) da 290 com a mesma assinatura e as mesmas colunas, lendo refreshed_at por ela.
--      Nada muda para quem chama (/api/me/sessions).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regprocedure('wacrm.user_sessions(uuid)');                  -- NÃO nulo (precisa da 290)
--   SELECT data_type FROM information_schema.columns
--    WHERE table_schema = 'auth' AND table_name = 'sessions' AND column_name = 'refreshed_at';   -- 'timestamp without time zone' (ou nenhuma linha em GoTrue antigo)
-- VERIFICAÇÃO:
--   SELECT wacrm.gotrue_ts('2026-10-09 12:00:00') = '2026-10-09T12:00:00Z'::timestamptz;   -- true, qualquer que seja o fuso da sessão
--   SELECT version FROM wacrm.schema_migrations WHERE version = '315_user_sessions_refreshed_at_utc';
-- ORDEM: antes ou depois do deploy (o código não muda). Idempotente.
-- ROLLBACK: reaplicar a 290 (CREATE OR REPLACE volta à versão antiga) e
--   DROP FUNCTION IF EXISTS wacrm.gotrue_ts(text); DELETE FROM wacrm.schema_migrations WHERE version = '315_user_sessions_refreshed_at_utc';
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION '315: falta auth.sessions — confira o schema vivo';
  END IF;
  IF to_regprocedure('wacrm.user_sessions(uuid)') IS NULL THEN
    RAISE EXCEPTION '315: falta wacrm.user_sessions(uuid) — aplique a 290 antes';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.gotrue_ts(p text)
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
           WHEN p IS NULL OR p = '' THEN NULL
           WHEN p ~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN p::timestamptz
           ELSE p::timestamp AT TIME ZONE 'UTC'
         END
$$;
REVOKE ALL ON FUNCTION wacrm.gotrue_ts(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.gotrue_ts(text) TO service_role;

CREATE OR REPLACE FUNCTION wacrm.user_sessions(p_user uuid)
RETURNS TABLE (id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, ip text, aal text, not_after timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, auth, public
AS $$
  SELECT s.id,
         s.created_at,
         coalesce(wacrm.gotrue_ts(to_jsonb(s) ->> 'refreshed_at'), s.updated_at),
         left(to_jsonb(s) ->> 'user_agent', 300),
         to_jsonb(s) ->> 'ip',
         to_jsonb(s) ->> 'aal',
         wacrm.gotrue_ts(to_jsonb(s) ->> 'not_after')
    FROM auth.sessions s
   WHERE s.user_id = p_user
   ORDER BY coalesce(wacrm.gotrue_ts(to_jsonb(s) ->> 'refreshed_at'), s.updated_at) DESC NULLS LAST
   LIMIT 100
$$;
REVOKE ALL ON FUNCTION wacrm.user_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.user_sessions(uuid) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('315_user_sessions_refreshed_at_utc') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
