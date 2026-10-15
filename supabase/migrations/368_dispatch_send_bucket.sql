-- ============================================================
-- 368_dispatch_send_bucket.sql   (worker de envio 20 × 80/s, etapa W2 — desenho: prd-v2/disparador-4800-pronto.md, PRD 12 §6.4)
--
-- O QUE FAZ:
--   1. wacrm.dispatch_send_bucket: balde de fichas DURÁVEL por número (GCRA: um instante `next_slot_at` por número). O limite por segundo
--      (efetivo: qualidade, rampa, cooldown, manual — calculado no app, channel-rate.ts) passa a valer ENTRE processos e reinícios, não só na
--      memória de um tick. 1 linha por número, 1 UPDATE por claim em lote (~4/s por número).
--   2. wacrm.reserve_send_slots(número, n, taxa, rajada): quantas fichas (≤ n) podem ser usadas AGORA. Rajada máxima = 1 s (padrão).
--   3. wacrm.claim_dispatch_batch_rated(número, n, campanhas, vagas, taxa, dono): o claim em lote existente (claim_dispatch_batch, 188/192) por
--      DENTRO, com (a) FENCING: se o dono informado não for o dono VIVO do número neste instante (367), não reivindica nada; (b) fichas do
--      balde: reivindica no máximo o que o balde concede e DEVOLVE ao balde o que não foi reivindicado. Devolve linhas (item, outcome):
--      'claimed' (item preenchido) ou, sem itens, uma linha com 'throttled' (o balde ainda não tem ficha: esperar), 'not_owner' (perdeu o
--      número) ou 'empty' (nada vencido/cota/limite). A regra do claim continua num lugar só (claim_dispatch_batch).
-- COMPATIBILIDADE: tudo novo e inerte; o cron atual continua chamando claim_dispatch_batch. Sem esta migration o worker não sobe (fica ocioso).
--   Depois da 188 (claim em lote) e da 367 (leases). Antes ou depois do deploy. Idempotente.
-- PRÉ-CHECK (rodar ANTES; schema vivo):
--   SELECT to_regclass('wacrm.dispatch_send_bucket');                                                                   -- NULL na 1ª vez
--   SELECT to_regprocedure('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)'), to_regprocedure('wacrm.dispatch_lease_is_owner(uuid,text)');  -- não nulos
--   SELECT pg_get_function_result('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)'::regprocedure);              -- TABLE(item jsonb)
--   SELECT to_regclass('wacrm.whatsapp_config');                                                                         -- não nulo
-- VERIFICAÇÃO:
--   SELECT to_regprocedure('wacrm.claim_dispatch_batch_rated(uuid,integer,uuid[],integer,numeric,text)');
--   SELECT version FROM wacrm.schema_migrations WHERE version = '368_dispatch_send_bucket';
-- ROLLBACK (executável; o teste PGlite executa este bloco):
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.claim_dispatch_batch_rated(uuid, integer, uuid[], integer, numeric, text);
--   DROP FUNCTION IF EXISTS wacrm.reserve_send_slots(uuid, integer, numeric, numeric);
--   DROP TABLE IF EXISTS wacrm.dispatch_send_bucket;
--   DELETE FROM wacrm.schema_migrations WHERE version = '368_dispatch_send_bucket';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION '368: falta wacrm.whatsapp_config';
  END IF;
  IF to_regprocedure('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)') IS NULL THEN
    RAISE EXCEPTION '368: falta wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer) (migration 188)';
  END IF;
  IF to_regprocedure('wacrm.dispatch_lease_is_owner(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '368: falta wacrm.dispatch_lease_is_owner(uuid,text) (migration 367)';
  END IF;
END $$;

-- Só o app (service_role) usa: sem leitura para o navegador (não há dado de cliente aqui).
CREATE TABLE IF NOT EXISTS wacrm.dispatch_send_bucket (
  session_id   uuid        PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  next_slot_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE wacrm.dispatch_send_bucket ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_send_bucket FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.dispatch_send_bucket TO service_role;

-- Quantas fichas (≤ p_n) podem ser usadas agora. Sem taxa (NULL/≤ 0) = sem limite (devolve p_n). Rajada máxima p_burst_seconds (0,1–5).
CREATE OR REPLACE FUNCTION wacrm.reserve_send_slots(p_session_id uuid, p_n integer, p_rate numeric, p_burst_seconds numeric DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_burst numeric := GREATEST(0.1, LEAST(5, COALESCE(p_burst_seconds, 1)));
  v_next timestamptz;
  v_start timestamptz;
  v_granted integer;
BEGIN
  IF p_n IS NULL OR p_n <= 0 THEN RETURN 0; END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN RETURN p_n; END IF;
  INSERT INTO wacrm.dispatch_send_bucket (session_id, next_slot_at) VALUES (p_session_id, v_now - make_interval(secs => v_burst))
    ON CONFLICT (session_id) DO NOTHING;
  SELECT next_slot_at INTO v_next FROM wacrm.dispatch_send_bucket WHERE session_id = p_session_id FOR UPDATE;
  v_start := GREATEST(v_next, v_now - make_interval(secs => v_burst));
  v_granted := LEAST(p_n, floor(extract(epoch FROM (v_now - v_start)) * p_rate)::integer);
  IF v_granted > 0 THEN
    UPDATE wacrm.dispatch_send_bucket SET next_slot_at = v_start + make_interval(secs => v_granted / p_rate) WHERE session_id = p_session_id;
  END IF;
  RETURN GREATEST(v_granted, 0);
END;
$$;

-- Claim em lote com fencing e balde (ver o cabeçalho). p_owner NULL = sem fencing (uso do cron, se um dia usar o balde).
CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_batch_rated(
  p_session_id uuid,
  p_n integer,
  p_campaign_ids uuid[],
  p_default_max_in_flight integer DEFAULT NULL,
  p_rate numeric DEFAULT NULL,
  p_owner text DEFAULT NULL
)
RETURNS TABLE (item jsonb, outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer := LEAST(GREATEST(COALESCE(p_n, 1), 1), 200);
  v_granted integer;
  v_items jsonb[];
  v_got integer;
BEGIN
  IF p_owner IS NOT NULL AND NOT wacrm.dispatch_lease_is_owner(p_session_id, p_owner) THEN
    RETURN QUERY SELECT NULL::jsonb, 'not_owner'::text;
    RETURN;
  END IF;
  v_granted := wacrm.reserve_send_slots(p_session_id, v_n, p_rate);
  IF v_granted <= 0 THEN
    RETURN QUERY SELECT NULL::jsonb, 'throttled'::text;
    RETURN;
  END IF;
  SELECT COALESCE(array_agg(c.item), ARRAY[]::jsonb[]) INTO v_items
    FROM wacrm.claim_dispatch_batch(p_session_id, v_granted, p_campaign_ids, p_default_max_in_flight) c;
  v_got := cardinality(v_items);
  -- Ficha não usada volta ao balde (nunca acima da rajada: o balde não acumula crédito além de 1 s).
  IF p_rate IS NOT NULL AND p_rate > 0 AND v_granted > v_got THEN
    UPDATE wacrm.dispatch_send_bucket
       SET next_slot_at = GREATEST(next_slot_at - make_interval(secs => (v_granted - v_got)::numeric / p_rate), clock_timestamp() - interval '1 second')
     WHERE session_id = p_session_id;
  END IF;
  IF v_got = 0 THEN
    RETURN QUERY SELECT NULL::jsonb, 'empty'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT i, 'claimed'::text FROM unnest(v_items) AS i;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.reserve_send_slots(uuid, integer, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.claim_dispatch_batch_rated(uuid, integer, uuid[], integer, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.reserve_send_slots(uuid, integer, numeric, numeric), wacrm.claim_dispatch_batch_rated(uuid, integer, uuid[], integer, numeric, text) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('368_dispatch_send_bucket') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
