-- ============================================================
-- 339_ai_daily_quota.sql   (plano de segurança 13/10, Âncora item 2 — cota diária de IA por conta)
--
-- Transcrição de áudio (STT) e sugestão de tabulação gastam a chave de IA da CONTA e não tinham teto: um laço (ou uma enxurrada de
-- áudios) esvaziava o saldo do cliente. Agora cada conta tem uma COTA DIÁRIA por tipo ('stt', 'tag_suggest'), contada por dia de
-- São Paulo. O padrão é GENEROSO e mora no código (DEFAULT_AI_DAILY_LIMITS); para mudar o teto de uma conta basta uma linha:
--   INSERT INTO wacrm.ai_daily_quota_config (account_id, kind, daily_limit) VALUES ('<conta>', 'stt', 20000)
--     ON CONFLICT (account_id, kind) DO UPDATE SET daily_limit = EXCLUDED.daily_limit, updated_at = now();
-- (0 bloqueia o tipo na conta). Sem .env. Objetos (todos fechados: RLS sem policy, só service_role):
--   wacrm.ai_daily_quota_config  (account_id, kind) PK, daily_limit >= 0
--   wacrm.ai_daily_quota_usage   (account_id, kind, day) PK, used
--   wacrm.consume_ai_quota(p_account uuid, p_kind text, p_default_limit integer) → jsonb {allowed, used, limit}
--     atômica: só incrementa se ainda houver cota (a chamada negada NÃO consome); limite = linha da conta OU o padrão passado.
-- COMPATIBILIDADE: sem esta migration o código segue SEM cota (a RPC ausente é ignorada). Pode rodar antes ou depois do deploy.
-- PRÉ-CHECK: SELECT to_regclass('wacrm.ai_daily_quota_usage'), (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--             WHERE n.nspname = 'wacrm' AND p.proname = 'consume_ai_quota');   -- NULL, 0 na 1ª vez
-- ROLLBACK:  DROP FUNCTION IF EXISTS wacrm.consume_ai_quota(uuid, text, integer);
--            DROP TABLE IF EXISTS wacrm.ai_daily_quota_usage; DROP TABLE IF EXISTS wacrm.ai_daily_quota_config;
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '339: falta wacrm.accounts — confira o schema vivo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.ai_daily_quota_config (
  account_id  uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('stt', 'tag_suggest')),
  daily_limit integer     NOT NULL CHECK (daily_limit >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  PRIMARY KEY (account_id, kind)
);

CREATE TABLE IF NOT EXISTS wacrm.ai_daily_quota_usage (
  account_id uuid    NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  kind       text    NOT NULL CHECK (kind IN ('stt', 'tag_suggest')),
  day        date    NOT NULL,
  used       integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (account_id, kind, day)
);
CREATE INDEX IF NOT EXISTS idx_ai_daily_quota_usage_day ON wacrm.ai_daily_quota_usage (day);

ALTER TABLE wacrm.ai_daily_quota_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.ai_daily_quota_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.ai_daily_quota_config, wacrm.ai_daily_quota_usage FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.ai_daily_quota_config, wacrm.ai_daily_quota_usage TO service_role;

CREATE OR REPLACE FUNCTION wacrm.consume_ai_quota(p_account uuid, p_kind text, p_default_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_day   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_limit integer;
  v_used  integer;
BEGIN
  IF p_account IS NULL OR p_kind NOT IN ('stt', 'tag_suggest') THEN
    RETURN jsonb_build_object('allowed', false, 'used', 0, 'limit', 0);
  END IF;
  SELECT c.daily_limit INTO v_limit FROM wacrm.ai_daily_quota_config c WHERE c.account_id = p_account AND c.kind = p_kind;
  v_limit := COALESCE(v_limit, GREATEST(COALESCE(p_default_limit, 0), 0));

  -- Limpeza barata de contagens antigas.
  DELETE FROM wacrm.ai_daily_quota_usage WHERE day < v_day - 10;

  -- Só incrementa se ainda houver cota: a chamada negada não consome.
  INSERT INTO wacrm.ai_daily_quota_usage AS u (account_id, kind, day, used)
  SELECT p_account, p_kind, v_day, 1 WHERE v_limit >= 1
  ON CONFLICT (account_id, kind, day) DO UPDATE SET used = u.used + 1 WHERE u.used < v_limit
  RETURNING u.used INTO v_used;

  IF v_used IS NULL THEN
    SELECT u.used INTO v_used FROM wacrm.ai_daily_quota_usage u WHERE u.account_id = p_account AND u.kind = p_kind AND u.day = v_day;
    RETURN jsonb_build_object('allowed', false, 'used', COALESCE(v_used, 0), 'limit', v_limit);
  END IF;
  RETURN jsonb_build_object('allowed', true, 'used', v_used, 'limit', v_limit);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.consume_ai_quota(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.consume_ai_quota(uuid, text, integer) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('339_ai_daily_quota') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
