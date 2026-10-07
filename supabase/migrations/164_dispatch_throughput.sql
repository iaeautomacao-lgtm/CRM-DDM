-- ============================================================
-- 164_dispatch_throughput.sql
--
-- Suporte ao agendador por número do cron do disparador
-- (src/lib/disparador/dispatch-scheduler.ts / throughput-config.ts).
--
-- 1) wacrm.dispatch_channel_cooldowns: cooldown curto por número depois de
--    sinal de limite do provedor (429, Meta 131048/131056/130429/80007/4,
--    5xx, timeout). Enquanto cooldown_until > now(), o cron começa o número
--    com metade da concorrência. Sem a tabela o cooldown vale só no
--    processo (memória).
--
-- 2) wacrm.claim_dispatch_item_capped(p_item_id, p_default_max_in_flight):
--    cópia EXATA de wacrm.claim_dispatch_item (migration 133), mudando só o
--    teto por número quando o canal NÃO tem linha em
--    dispatch_channel_limits: COALESCE(max_in_flight, p_default, 4) em vez
--    de COALESCE(max_in_flight, 4). claim_dispatch_item não é alterada.
--    O app só chama a _capped quando o padrão configurado
--    (DISPARADOR_PER_NUMBER_CONCURRENCY*) é diferente de 4; com os padrões,
--    nada muda. ANTES de aplicar, confira que o corpo de produção de
--    claim_dispatch_item ainda é o da 133:
--      SELECT pg_get_functiondef('wacrm.claim_dispatch_item(uuid)'::regprocedure);
--    Se divergir, replique aqui a versão de produção.
--
-- 3) wacrm.dispatch_throughput_per_minute: envios por minuto por número
--    (últimas 24h) a partir de disp_message_queue.sent_at, para o gráfico
--    de calibração. Ex.:
--      SELECT * FROM wacrm.dispatch_throughput_per_minute
--      WHERE minute > now() - interval '2 hours' ORDER BY minute DESC;
--    Telemetria do tick: system_logs source='disparador' event='cron_tick'
--    (consulta em src/lib/disparador/dispatch-telemetry.ts).
--
-- ORDEM: pode ser aplicada antes ou depois do deploy (o app tolera a
-- ausência). Precisa estar aplicada ANTES de subir o padrão por número
-- acima de 4 via env — sem ela o banco continua limitando a 4.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_channel_cooldowns (
  session_id uuid PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  cooldown_until timestamptz NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wacrm.dispatch_channel_cooldowns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_channel_cooldowns FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.dispatch_channel_cooldowns TO service_role;

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
  v_count bigint;
  v_concurrency integer := 4;
  v_channel_limit integer;
BEGIN
  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE id = p_item_id;

  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO v_campaign
  FROM wacrm.campaigns
  WHERE id = v_item.campaign_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_campaign.status <> 'em_execucao'
     OR v_item.session_id IS NULL
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

  SELECT count(*) INTO v_count
  FROM wacrm.disp_message_queue
  WHERE campaign_id = v_campaign.id
    AND (
      status = 'enviando'
      OR sent_at >= clock_timestamp() - interval '1 hour'
    );

  IF COALESCE(v_campaign.limite_por_hora, 0) > 0
     AND v_count >= v_campaign.limite_por_hora
  THEN
    RETURN false;
  END IF;

  SELECT max_in_flight, hourly_limit
  INTO v_concurrency, v_channel_limit
  FROM wacrm.dispatch_channel_limits
  WHERE session_id = v_item.session_id;

  -- Única diferença para claim_dispatch_item: o padrão sem linha vem do
  -- app (faixa 1..50, a mesma do CHECK de max_in_flight).
  v_concurrency := COALESCE(
    v_concurrency,
    CASE WHEN p_default_max_in_flight BETWEEN 1 AND 50 THEN p_default_max_in_flight END,
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

CREATE OR REPLACE VIEW wacrm.dispatch_throughput_per_minute
WITH (security_invoker = true) AS
SELECT
  q.session_id,
  date_trunc('minute', q.sent_at) AS minute,
  count(*)::integer AS sent
FROM wacrm.disp_message_queue q
WHERE q.sent_at >= now() - interval '24 hours'
GROUP BY q.session_id, date_trunc('minute', q.sent_at);

REVOKE ALL ON wacrm.dispatch_throughput_per_minute FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.dispatch_throughput_per_minute TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
