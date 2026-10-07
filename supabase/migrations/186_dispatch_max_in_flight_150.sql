-- ============================================================
-- 186_dispatch_max_in_flight_150.sql   (P1-3a — tetos 50 → 150)
--
-- Meta: 80 envios/s POR NÚMERO. Com ~1 s de latência da Meta isso pede ~80–100 envios em voo por número; o teto de 50
-- (CHECK de dispatch_channel_limits.max_in_flight e faixa do padrão em claim_dispatch_item_capped) limitava a ~50/s.
-- Esta migration sobe o teto para 150 em DOIS pontos do banco (o código usa 150 como teto por número e global):
--   1) CHECK de dispatch_channel_limits.max_in_flight: BETWEEN 1 AND 150;
--   2) wacrm.claim_dispatch_item_capped: o padrão vindo do app (p_default_max_in_flight) vale em 1..150
--      (fora da faixa continua caindo para 4). Corpo = o da 167 com SÓ essa faixa trocada.
-- WAHA continua com teto próprio baixo no código (50) — risco de banimento; o banco não distingue provedor.
--
-- PRÉ-CHECK (rode ANTES e confira — o corpo de produção pode divergir da 167):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'wacrm.dispatch_channel_limits'::regclass AND contype = 'c';
--   -- esperado: um CHECK com "max_in_flight >= 1 AND max_in_flight <= 50" (nome automático dispatch_channel_limits_max_in_flight_check)
--   SELECT pg_get_functiondef('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure);
--   -- esperado: igual à 167 (procure "p_default_max_in_flight BETWEEN 1 AND 50"). Se divergir, NÃO rode: ajuste este arquivo.
--   SELECT max(max_in_flight) FROM wacrm.dispatch_channel_limits;   -- deve caber em 1..150
--
-- ORDEM: aplicar ANTES do deploy do código que usa 150 (código novo + banco antigo: linha com max_in_flight > 50 seria
-- recusada pelo CHECK antigo; o padrão do app > 50 cairia para 4 no claim antigo).
-- Idempotente: pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_def text;
  v_con record;
BEGIN
  IF to_regclass('wacrm.dispatch_channel_limits') IS NULL THEN
    RAISE EXCEPTION '186: falta wacrm.dispatch_channel_limits (migration 118/133)';
  END IF;
  IF to_regprocedure('wacrm.claim_dispatch_item_capped(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION '186: falta wacrm.claim_dispatch_item_capped(uuid,integer) (migration 164/167)';
  END IF;
  IF EXISTS (SELECT 1 FROM wacrm.dispatch_channel_limits WHERE max_in_flight NOT BETWEEN 1 AND 150) THEN
    RAISE EXCEPTION '186: há max_in_flight fora de 1..150 em dispatch_channel_limits';
  END IF;
  SELECT pg_get_functiondef('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure) INTO v_def;
  IF position('p_default_max_in_flight BETWEEN 1 AND 150' IN v_def) = 0
     AND position('p_default_max_in_flight BETWEEN 1 AND 50' IN v_def) = 0 THEN
    RAISE EXCEPTION '186: o corpo de claim_dispatch_item_capped em produção diverge da 167 (faixa do padrão não encontrada) — confira com pg_get_functiondef e ajuste esta migration';
  END IF;

  -- Remove o(s) CHECK(s) sobre max_in_flight (qualquer nome) e recria com o teto novo.
  FOR v_con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'wacrm.dispatch_channel_limits'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%max_in_flight%'
  LOOP
    EXECUTE format('ALTER TABLE wacrm.dispatch_channel_limits DROP CONSTRAINT %I', v_con.conname);
  END LOOP;
  ALTER TABLE wacrm.dispatch_channel_limits
    ADD CONSTRAINT dispatch_channel_limits_max_in_flight_check CHECK (max_in_flight BETWEEN 1 AND 150);
END $$;

-- ---------- 2) claim com o padrão do app em 1..150 ----------
CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_item_capped(
  p_item_id uuid,
  p_default_max_in_flight integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item wacrm.disp_message_queue%ROWTYPE;
  v_campaign wacrm.campaigns%ROWTYPE;
  v_hourly_limit integer;
  v_count bigint;
  v_concurrency integer := 4;
  v_channel_limit integer;
BEGIN
  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE id = p_item_id;

  IF NOT FOUND OR v_item.session_id IS NULL THEN RETURN false; END IF;

  -- Leitura sem lock só para escolher o modo do lock.
  SELECT limite_por_hora INTO v_hourly_limit
  FROM wacrm.campaigns
  WHERE id = v_item.campaign_id;

  IF NOT FOUND THEN RETURN false; END IF;

  IF COALESCE(v_hourly_limit, 0) > 0 THEN
    SELECT * INTO v_campaign
    FROM wacrm.campaigns
    WHERE id = v_item.campaign_id
    FOR UPDATE;
  ELSE
    SELECT * INTO v_campaign
    FROM wacrm.campaigns
    WHERE id = v_item.campaign_id
    FOR SHARE;
  END IF;

  IF NOT FOUND
     OR v_campaign.status <> 'em_execucao'
     -- Limite ligado entre a leitura e o lock: o lock compartilhado não
     -- protege a contagem; recusa (o item volta no próximo tick).
     OR (COALESCE(v_hourly_limit, 0) <= 0 AND COALESCE(v_campaign.limite_por_hora, 0) > 0)
  THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_item.session_id::text, 118)
  );

  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE id = p_item_id
  FOR UPDATE;

  IF v_item.status <> 'agendado'
     OR v_item.scheduled_at > clock_timestamp()
  THEN
    RETURN false;
  END IF;

  IF v_item.campaign_id IS DISTINCT FROM v_campaign.id
     OR NULLIF(v_item.waha_message_id, '') IS NOT NULL
  THEN
    RETURN false;
  END IF;

  -- Contagem horária da campanha só quando há limite (com FOR UPDATE).
  IF COALESCE(v_campaign.limite_por_hora, 0) > 0 THEN
    SELECT count(*) INTO v_count
    FROM wacrm.disp_message_queue
    WHERE campaign_id = v_campaign.id
      AND (
        status = 'enviando'
        OR sent_at >= clock_timestamp() - interval '1 hour'
      );

    IF v_count >= v_campaign.limite_por_hora THEN RETURN false; END IF;
  END IF;

  SELECT max_in_flight, hourly_limit
  INTO v_concurrency, v_channel_limit
  FROM wacrm.dispatch_channel_limits
  WHERE session_id = v_item.session_id;

  -- Sem linha do canal: padrão do app (faixa 1..150, a mesma do CHECK de
  -- max_in_flight); NULL → 4 (claim_dispatch_item).
  v_concurrency := COALESCE(
    v_concurrency,
    CASE WHEN p_default_max_in_flight BETWEEN 1 AND 150 THEN p_default_max_in_flight END,
    4
  );

  SELECT count(*) INTO v_count
  FROM wacrm.disp_message_queue
  WHERE session_id = v_item.session_id
    AND status = 'enviando';

  IF v_count >= v_concurrency THEN RETURN false; END IF;

  IF v_channel_limit IS NOT NULL THEN
    SELECT count(*) INTO v_count
    FROM wacrm.disp_message_queue
    WHERE session_id = v_item.session_id
      AND (
        status = 'enviando'
        OR sent_at >= clock_timestamp() - interval '1 hour'
      );

    IF v_count >= v_channel_limit THEN RETURN false; END IF;
  END IF;

  UPDATE wacrm.disp_message_queue
  SET status = 'enviando',
      updated_at = clock_timestamp()
  WHERE id = p_item_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.claim_dispatch_item_capped(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_dispatch_item_capped(uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
