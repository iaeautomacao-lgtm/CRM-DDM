-- ============================================================
-- 221_rate_limit_shared.sql   (PRD 14, 14.9 — rate limit compartilhado no Postgres; AP-03/AP-08/AP-09/AP-19)
--
-- PROBLEMA: src/lib/rate-limit.ts guarda os contadores num Map POR PROCESSO. Cada instância do Passenger e cada restart/deploy
-- zeram o contador: N instâncias = N× o limite; subir uma versão libera tudo (send, convites, redeem-by-code 5/5 min, API v1,
-- simulador, IA, verificação do webhook, channel-test).
--
-- O QUE FAZ (Postgres, sem infra nova — decisão do PRD 14 / princípio do .env mínimo):
--   1. wacrm.rate_limit_buckets (UNLOGGED: contador efêmero, mais rápido e sem WAL; um crash do banco zera os contadores, que é
--      aceitável): uma linha por (chave, janela). Fechada: RLS ligada sem policy; só service_role.
--   2. wacrm.rate_limit_hit(p_key, p_limit, p_window_s) → (success, remaining, reset_at): UM upsert atômico
--      (INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING) numa janela fixa alinhada ao relógio do banco
--      (floor(epoch / janela)). SECURITY DEFINER, só service_role. Valida os argumentos (limite ≥ 1, janela 1 s…1 dia, chave ≤ 200).
--   3. Limpeza barata: ~0,5% das chamadas apagam as janelas vencidas (índice em expires_at); wacrm.rate_limit_cleanup() faz o mesmo
--      sob demanda (ops/cron opcional).
-- O app mantém o Map como 1º nível (barra rajada dentro do processo) e usa esta RPC como 2º; se a RPC falhar ou não existir, cai no
-- Map (nunca derruba a rota por causa do limitador).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.accounts');                                    -- não nulo (schema wacrm vivo)
--   SELECT to_regclass('wacrm.rate_limit_buckets'), to_regprocedure('wacrm.rate_limit_hit(text,integer,integer)');   -- NULL na 1ª vez
-- VERIFICAÇÃO (service role / SQL Editor):
--   SELECT * FROM wacrm.rate_limit_hit('teste:221', 2, 60);   -- (true,1,…)   (true,0,…)   (false,0,…) na 3ª chamada
--   DELETE FROM wacrm.rate_limit_buckets WHERE key = 'teste:221';
-- ORDEM: antes ou depois do deploy (sem a 221 o app usa o Map, como hoje). Idempotente.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS wacrm.rate_limit_hit(text, integer, integer);
--   DROP FUNCTION IF EXISTS wacrm.rate_limit_cleanup();
--   DROP TABLE IF EXISTS wacrm.rate_limit_buckets;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '221: schema wacrm sem accounts — confira o schema vivo';
  END IF;
  IF to_regclass('wacrm.rate_limit_buckets') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'rate_limit_buckets' AND column_name = 'expires_at'
  ) THEN
    RAISE EXCEPTION '221: wacrm.rate_limit_buckets já existe com outro formato — nada foi alterado';
  END IF;
END $$;

CREATE UNLOGGED TABLE IF NOT EXISTS wacrm.rate_limit_buckets (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires ON wacrm.rate_limit_buckets (expires_at);

ALTER TABLE wacrm.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.rate_limit_buckets TO service_role;

CREATE OR REPLACE FUNCTION wacrm.rate_limit_cleanup()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, pg_catalog
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM wacrm.rate_limit_buckets WHERE expires_at < now() - interval '1 minute';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.rate_limit_hit(p_key text, p_limit integer, p_window_s integer)
RETURNS TABLE (success boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, pg_catalog
AS $$
DECLARE
  v_start   timestamptz;
  v_expires timestamptz;
  v_count   integer;
BEGIN
  IF p_key IS NULL OR length(p_key) = 0 OR length(p_key) > 200 THEN
    RAISE EXCEPTION 'rate_limit_hit: chave inválida' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'rate_limit_hit: limite deve ser >= 1' USING ERRCODE = '22023';
  END IF;
  IF p_window_s IS NULL OR p_window_s < 1 OR p_window_s > 86400 THEN
    RAISE EXCEPTION 'rate_limit_hit: janela deve estar entre 1 s e 1 dia' USING ERRCODE = '22023';
  END IF;

  -- Janela fixa alinhada ao relógio do BANCO: todas as instâncias da aplicação enxergam a mesma janela.
  v_start := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / p_window_s) * p_window_s);
  v_expires := v_start + make_interval(secs => p_window_s);

  INSERT INTO wacrm.rate_limit_buckets AS b (key, window_start, expires_at, count)
  VALUES (p_key, v_start, v_expires, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = b.count + 1
  RETURNING b.count INTO v_count;

  -- ~0,5% das chamadas varrem as janelas vencidas (barato: índice em expires_at).
  IF random() < 0.005 THEN
    DELETE FROM wacrm.rate_limit_buckets WHERE expires_at < now() - interval '1 minute';
  END IF;

  RETURN QUERY SELECT v_count <= p_limit, greatest(p_limit - v_count, 0), v_expires;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.rate_limit_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.rate_limit_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.rate_limit_hit(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.rate_limit_cleanup() TO service_role;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('221_rate_limit_shared') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
