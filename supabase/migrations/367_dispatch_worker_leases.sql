-- ============================================================
-- 367_dispatch_worker_leases.sql   (worker de envio 20 × 80/s, etapa W1 — decisão do dono de 15/10; desenho: prd-v2/disparador-4800-pronto.md, PRD 12 §6.2)
--
-- O QUE FAZ:
--   1. wacrm.dispatch_channel_ownership: QUEM envia cada número Meta: 'cron' (o tick de hoje; padrão, e é o que vale sem linha) ou 'worker'
--      (processo de envio dedicado), com grupo opcional. Mudar para 'cron' devolve o número ao tick em ≤ 1 rodada (rollback sem deploy).
--   2. wacrm.dispatch_worker_leases: o DONO VIVO de cada número que está em 'worker' (lease com TTL, renovado a cada ~10 s). Máximo um dono por
--      número: só se troca depois que o lease expira ou por quem já é dono. \`generation\` sobe a cada troca de dono (rastreio/fencing).
--   3. RPCs (SECURITY DEFINER, só service_role): acquire_dispatch_leases, renew_dispatch_leases, release_dispatch_leases, live_worker_sessions,
--      dispatch_lease_is_owner (usada pelo claim com fencing na etapa W2).
--   4. dispatch_engine_flags.worker_enabled (a chave do worker por conta; NULL = segue DISPATCH_WORKER_ENABLED; padrão desligado).
-- COMPATIBILIDADE: tudo novo e inerte. Sem linha de ownership o número segue no cron; com a chave desligada o cron ignora leases. Sem esta
--   migration o código segue exatamente como hoje (as leituras toleram a ausência). Antes ou depois do deploy. Idempotente. Depois da 366.
-- PRÉ-CHECK (rodar ANTES; schema vivo):
--   SELECT to_regclass('wacrm.dispatch_channel_ownership'), to_regclass('wacrm.dispatch_worker_leases');             -- NULL, NULL na 1ª vez
--   SELECT to_regclass('wacrm.whatsapp_config'), to_regclass('wacrm.accounts'), to_regclass('wacrm.dispatch_engine_flags');   -- não nulos (366)
--   SELECT to_regprocedure('wacrm.has_perm(text)'), (SELECT count(*) FROM pg_proc WHERE proname = 'is_account_member');    -- não nulo / ≥ 1
-- VERIFICAÇÃO:
--   SELECT to_regprocedure('wacrm.acquire_dispatch_leases(text,uuid[],integer)');
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='dispatch_engine_flags' AND column_name='worker_enabled';
--   SELECT version FROM wacrm.schema_migrations WHERE version = '367_dispatch_worker_leases';
-- ROLLBACK (executável; o teste PGlite executa este bloco):
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.acquire_dispatch_leases(text, uuid[], integer);
--   DROP FUNCTION IF EXISTS wacrm.renew_dispatch_leases(text, uuid[], integer, jsonb);
--   DROP FUNCTION IF EXISTS wacrm.release_dispatch_leases(text);
--   DROP FUNCTION IF EXISTS wacrm.live_worker_sessions();
--   DROP FUNCTION IF EXISTS wacrm.dispatch_lease_is_owner(uuid, text);
--   DROP TABLE IF EXISTS wacrm.dispatch_worker_leases;
--   DROP TABLE IF EXISTS wacrm.dispatch_channel_ownership;
--   ALTER TABLE wacrm.dispatch_engine_flags DROP COLUMN IF EXISTS worker_enabled;
--   DELETE FROM wacrm.schema_migrations WHERE version = '367_dispatch_worker_leases';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.whatsapp_config') IS NULL OR to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '367: faltam wacrm.whatsapp_config/accounts';
  END IF;
  IF to_regclass('wacrm.dispatch_engine_flags') IS NULL THEN
    RAISE EXCEPTION '367: falta wacrm.dispatch_engine_flags — aplique a 366 antes';
  END IF;
  -- is_account_member: a assinatura real é (uuid, account_role_enum) — procura pelo NOME (regra: pré-check com assinatura real ou por nome).
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '367: faltam wacrm.has_perm / wacrm.is_account_member';
  END IF;
END $$;

-- 4. chave do worker por conta (NULL = segue o ambiente)
ALTER TABLE wacrm.dispatch_engine_flags ADD COLUMN IF NOT EXISTS worker_enabled boolean;

-- 1. ownership
CREATE TABLE IF NOT EXISTS wacrm.dispatch_channel_ownership (
  session_id   uuid        PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  account_id   uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  mode         text        NOT NULL DEFAULT 'cron' CHECK (mode IN ('cron', 'worker')),
  worker_group text,
  reason       text,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 2. leases
CREATE TABLE IF NOT EXISTS wacrm.dispatch_worker_leases (
  session_id   uuid        PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  account_id   uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  owner_id     text        NOT NULL,
  lease_until  timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  generation   bigint      NOT NULL DEFAULT 1,
  stats        jsonb
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dispatch_channel_ownership', 'dispatch_worker_leases'] LOOP
    EXECUTE format('ALTER TABLE wacrm.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON wacrm.%I', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON wacrm.%I FOR SELECT USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm(''campaigns.rate_limit'')))',
      t || '_select', t);
    EXECUTE format('REVOKE ALL ON wacrm.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON wacrm.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON wacrm.%I TO service_role', t);
  END LOOP;
END $$;

-- 2FA (migration 310): se já aplicada, cobre as tabelas aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy'
  ) THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.dispatch_channel_ownership'::regclass);
    PERFORM wacrm.apply_mfa_policy('wacrm.dispatch_worker_leases'::regclass);
  END IF;
END $$;

-- 3. RPCs
-- Adquire (ou reafirma) o dono dos números pedidos, só dos que estão em mode='worker'. Devolve os que ficaram com p_owner.
CREATE OR REPLACE FUNCTION wacrm.acquire_dispatch_leases(p_owner text, p_session_ids uuid[], p_ttl_seconds integer DEFAULT 30)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_ttl integer := GREATEST(5, LEAST(300, COALESCE(p_ttl_seconds, 30)));
BEGIN
  IF p_owner IS NULL OR btrim(p_owner) = '' THEN
    RAISE EXCEPTION 'owner obrigatório';
  END IF;
  WITH cand AS (
    SELECT o.session_id, o.account_id
      FROM wacrm.dispatch_channel_ownership o
     WHERE o.mode = 'worker' AND o.session_id = ANY (COALESCE(p_session_ids, '{}'::uuid[]))
  ), up AS (
    INSERT INTO wacrm.dispatch_worker_leases AS l (session_id, account_id, owner_id, lease_until, heartbeat_at)
    SELECT c.session_id, c.account_id, p_owner, clock_timestamp() + make_interval(secs => v_ttl), clock_timestamp() FROM cand c
    ON CONFLICT (session_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           lease_until = EXCLUDED.lease_until,
           heartbeat_at = EXCLUDED.heartbeat_at,
           generation = CASE WHEN l.owner_id = EXCLUDED.owner_id THEN l.generation ELSE l.generation + 1 END
     WHERE l.lease_until <= clock_timestamp() OR l.owner_id = EXCLUDED.owner_id
    RETURNING l.session_id
  )
  SELECT COALESCE(array_agg(session_id), '{}'::uuid[]) INTO v_ids FROM up;
  RETURN v_ids;
END;
$$;

-- Renova só o que AINDA é do p_owner (lease não expirado e número ainda em mode='worker'); o resto é perdido e deve parar de enviar.
CREATE OR REPLACE FUNCTION wacrm.renew_dispatch_leases(p_owner text, p_session_ids uuid[], p_ttl_seconds integer DEFAULT 30, p_stats jsonb DEFAULT NULL)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_ttl integer := GREATEST(5, LEAST(300, COALESCE(p_ttl_seconds, 30)));
BEGIN
  WITH up AS (
    UPDATE wacrm.dispatch_worker_leases l
       SET lease_until = clock_timestamp() + make_interval(secs => v_ttl),
           heartbeat_at = clock_timestamp(),
           stats = COALESCE(p_stats, l.stats)
     WHERE l.owner_id = p_owner
       AND l.session_id = ANY (COALESCE(p_session_ids, '{}'::uuid[]))
       AND l.lease_until > clock_timestamp()
       AND EXISTS (SELECT 1 FROM wacrm.dispatch_channel_ownership o WHERE o.session_id = l.session_id AND o.mode = 'worker')
    RETURNING l.session_id
  )
  SELECT COALESCE(array_agg(session_id), '{}'::uuid[]) INTO v_ids FROM up;
  RETURN v_ids;
END;
$$;

-- Parada limpa (SIGTERM): expira os leases do p_owner já (mantém a linha para não perder a generation). Devolve quantos.
CREATE OR REPLACE FUNCTION wacrm.release_dispatch_leases(p_owner text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE wacrm.dispatch_worker_leases
     SET lease_until = clock_timestamp() - interval '1 second', heartbeat_at = clock_timestamp()
   WHERE owner_id = p_owner AND lease_until > clock_timestamp();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Números com dono vivo E ainda em mode='worker': é isto que o cron lê para NÃO enviar esses números (lease expirado ou mode='cron' = o cron assume).
CREATE OR REPLACE FUNCTION wacrm.live_worker_sessions()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(l.session_id), '{}'::uuid[])
    FROM wacrm.dispatch_worker_leases l
    JOIN wacrm.dispatch_channel_ownership o ON o.session_id = l.session_id AND o.mode = 'worker'
   WHERE l.lease_until > clock_timestamp();
$$;

-- Fencing: p_owner ainda é o dono VIVO deste número neste instante? (o claim com rate, W2, confere isto na mesma transação.)
CREATE OR REPLACE FUNCTION wacrm.dispatch_lease_is_owner(p_session_id uuid, p_owner text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM wacrm.dispatch_worker_leases l
      JOIN wacrm.dispatch_channel_ownership o ON o.session_id = l.session_id AND o.mode = 'worker'
     WHERE l.session_id = p_session_id AND l.owner_id = p_owner AND l.lease_until > clock_timestamp()
  );
$$;

REVOKE ALL ON FUNCTION wacrm.acquire_dispatch_leases(text, uuid[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.renew_dispatch_leases(text, uuid[], integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.release_dispatch_leases(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.live_worker_sessions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.dispatch_lease_is_owner(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.acquire_dispatch_leases(text, uuid[], integer), wacrm.renew_dispatch_leases(text, uuid[], integer, jsonb),
  wacrm.release_dispatch_leases(text), wacrm.live_worker_sessions(), wacrm.dispatch_lease_is_owner(uuid, text) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('367_dispatch_worker_leases') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
