-- 118 — Coordenação de envios do disparador no banco.
--
-- Move para RPCs transacionais as decisões que antes eram feitas no código
-- (sujeitas a corrida entre cron, worker e várias instâncias):
--   reserve_campaign_tick      → cadência: um lote por campanha a cada batch_pause_seconds
--   claim_dispatch_item        → claim agendado→enviando com quota e concorrência por canal
--   complete_dispatch_campaign → encerra só quando não há trabalho pendente/em voo
--   resume_/stop_dispatch_campaign → pausa/retomada/encerramento atômicos por conta
--   mark_queue_item_sent       → confirmação idempotente (repetir não duplica log/métrica)
-- Todas são SECURITY DEFINER com search_path vazio e executáveis só pelo service_role.
--
-- Apply before deploying the application. No automatic recovery of unknown sends.
BEGIN;

ALTER TABLE wacrm.campaigns ADD COLUMN IF NOT EXISTS next_batch_at timestamptz;

-- Quota checks run for each claim; avoid scanning the full queue per message.
CREATE INDEX IF NOT EXISTS idx_dispatch_channel_in_flight ON wacrm.disp_message_queue(session_id) WHERE status = 'enviando';
CREATE INDEX IF NOT EXISTS idx_dispatch_campaign_in_flight ON wacrm.disp_message_queue(campaign_id) WHERE status = 'enviando';
CREATE INDEX IF NOT EXISTS idx_dispatch_channel_sent_at ON wacrm.disp_message_queue(session_id, sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_campaign_sent_at ON wacrm.disp_message_queue(campaign_id, sent_at) WHERE sent_at IS NOT NULL;

-- Shared by every campaign using a channel. Service-role configuration only.
CREATE TABLE IF NOT EXISTS wacrm.dispatch_channel_limits (
  session_id uuid PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  max_in_flight integer NOT NULL DEFAULT 4 CHECK (max_in_flight BETWEEN 1 AND 50),
  hourly_limit integer CHECK (hourly_limit > 0)
);
ALTER TABLE wacrm.dispatch_channel_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_channel_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.dispatch_channel_limits TO service_role;

-- Cadência por campanha: reserva o próximo lote gravando next_batch_at.
-- Retorna false se a campanha não está em execução ou a pausa ainda não passou.
CREATE OR REPLACE FUNCTION wacrm.reserve_campaign_tick(p_campaign_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE wacrm.campaigns
  SET next_batch_at = clock_timestamp() + make_interval(secs => GREATEST(COALESCE(batch_pause_seconds, 0), 1))
  WHERE id = p_campaign_id AND status = 'em_execucao'
    AND (next_batch_at IS NULL OR next_batch_at <= clock_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- Claim de um item da fila (agendado → enviando). Retorna true só para o
-- vencedor e apenas se: campanha em execução, item vencido e sem message ID,
-- dentro do limite_por_hora da campanha e dos limites do canal
-- (max_in_flight / hourly_limit). Itens 'enviando' contam no limite, inclusive
-- os de resultado desconhecido aguardando reconciliação.
CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_item(p_item_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item wacrm.disp_message_queue%ROWTYPE;
  v_campaign wacrm.campaigns%ROWTYPE;
  v_count bigint;
  v_concurrency integer := 4;
  v_channel_limit integer;
BEGIN
  SELECT * INTO v_item FROM wacrm.disp_message_queue WHERE id = p_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Claims and completion take the same campaign lock. Channel lock serializes
  -- reservations from distinct campaigns; accepted/unknown in-flight work counts.
  SELECT * INTO v_campaign FROM wacrm.campaigns WHERE id = v_item.campaign_id FOR UPDATE;
  IF NOT FOUND OR v_campaign.status <> 'em_execucao' OR v_item.session_id IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_item.session_id::text, 118));
  SELECT * INTO v_item FROM wacrm.disp_message_queue WHERE id = p_item_id FOR UPDATE;
  IF v_item.status <> 'agendado' OR v_item.scheduled_at > clock_timestamp() THEN RETURN false; END IF;
  IF v_item.campaign_id IS DISTINCT FROM v_campaign.id OR NULLIF(v_item.waha_message_id, '') IS NOT NULL THEN RETURN false; END IF;

  SELECT count(*) INTO v_count FROM wacrm.disp_message_queue
  WHERE campaign_id = v_campaign.id
    AND (status = 'enviando' OR sent_at >= clock_timestamp() - interval '1 hour');
  IF COALESCE(v_campaign.limite_por_hora, 0) > 0 AND v_count >= v_campaign.limite_por_hora THEN RETURN false; END IF;

  SELECT max_in_flight, hourly_limit INTO v_concurrency, v_channel_limit
  FROM wacrm.dispatch_channel_limits WHERE session_id = v_item.session_id;
  v_concurrency := COALESCE(v_concurrency, 4);
  SELECT count(*) INTO v_count FROM wacrm.disp_message_queue
  WHERE session_id = v_item.session_id AND status = 'enviando';
  IF v_count >= v_concurrency THEN RETURN false; END IF;
  IF v_channel_limit IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM wacrm.disp_message_queue
    WHERE session_id = v_item.session_id
      AND (status = 'enviando' OR sent_at >= clock_timestamp() - interval '1 hour');
    IF v_count >= v_channel_limit THEN RETURN false; END IF;
  END IF;

  UPDATE wacrm.disp_message_queue SET status = 'enviando', updated_at = clock_timestamp()
  WHERE id = p_item_id;
  RETURN true;
END;
$$;

-- Encerra a campanha quando não resta nada agendado, enviando, pausado ou
-- com retry pendente. Usa o mesmo lock de campanha do claim.
CREATE OR REPLACE FUNCTION wacrm.complete_dispatch_campaign(p_campaign_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM wacrm.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'em_execucao' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM wacrm.disp_message_queue WHERE campaign_id = p_campaign_id) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM wacrm.disp_message_queue WHERE campaign_id = p_campaign_id
    AND (status IN ('agendado', 'enviando', 'pausado')
      OR (status = 'erro' AND erro_permanente = false AND tentativas < 5))
  ) THEN RETURN false; END IF;
  UPDATE wacrm.campaigns SET status = 'encerrada', updated_at = clock_timestamp() WHERE id = p_campaign_id;
  RETURN true;
END;
$$;

-- Retoma campanha pausada: itens 'pausado' voltam a 'agendado'. Retorna o
-- número de itens reativados, ou NULL se a campanha não estava pausada.
CREATE OR REPLACE FUNCTION wacrm.resume_dispatch_campaign(p_campaign_id uuid, p_account_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text; v_count integer;
BEGIN
  SELECT status INTO v_status FROM wacrm.campaigns
    WHERE id = p_campaign_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'pausada' THEN RETURN NULL; END IF;
  UPDATE wacrm.disp_message_queue SET status = 'agendado', scheduled_at = clock_timestamp()
    WHERE campaign_id = p_campaign_id AND status = 'pausado';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE wacrm.campaigns SET status = 'em_execucao', next_batch_at = NULL WHERE id = p_campaign_id;
  RETURN v_count;
END;
$$;

-- Pausa ('pause') ou encerra ('stop') a campanha e os itens ainda não
-- enviados, numa única transação. Itens 'enviando' não são alterados.
CREATE OR REPLACE FUNCTION wacrm.stop_dispatch_campaign(p_campaign_id uuid, p_account_id uuid, p_action text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  IF p_action NOT IN ('pause', 'stop') THEN RAISE EXCEPTION 'Invalid campaign action'; END IF;
  SELECT status INTO v_status FROM wacrm.campaigns
    WHERE id = p_campaign_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- A partially prepared campaign cannot be paused and resumed as a full queue.
  IF p_action = 'pause' AND v_status <> 'em_execucao' THEN RETURN false; END IF;
  UPDATE wacrm.campaigns SET status = CASE WHEN p_action = 'pause' THEN 'pausada' ELSE 'encerrada' END
    WHERE id = p_campaign_id;
  UPDATE wacrm.disp_message_queue
    SET status = CASE WHEN p_action = 'pause' THEN 'pausado' ELSE 'cancelado' END
    WHERE campaign_id = p_campaign_id AND status IN ('agendado', 'pendente', 'pausado');
  -- In-flight work is never turned into a new scheduled operation.
  RETURN true;
END;
$$;

-- Repeatable local confirmation: a repeated RPC does not duplicate logs/metrics.
CREATE OR REPLACE FUNCTION wacrm.mark_queue_item_sent(
  p_item_id uuid, p_campaign_id uuid, p_contact_id uuid, p_session_id uuid,
  p_mensagem text, p_waha_message_id text, p_tentativas integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item wacrm.disp_message_queue%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM wacrm.disp_message_queue WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND OR v_item.campaign_id IS DISTINCT FROM p_campaign_id
    OR v_item.contact_id IS DISTINCT FROM p_contact_id
    OR v_item.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'Queue item identity mismatch';
  END IF;
  IF v_item.status IN ('enviado', 'entregue', 'lido') AND v_item.waha_message_id = p_waha_message_id THEN RETURN; END IF;
  IF v_item.status <> 'enviando' OR NULLIF(p_waha_message_id, '') IS NULL THEN
    RAISE EXCEPTION 'Queue item is not awaiting confirmation';
  END IF;
  UPDATE wacrm.disp_message_queue SET status = 'enviado', sent_at = clock_timestamp(),
    updated_at = clock_timestamp(), waha_message_id = p_waha_message_id,
    tentativas = p_tentativas, erro = NULL WHERE id = p_item_id;
  INSERT INTO wacrm.message_logs (queue_id, campaign_id, contact_id, session_id, direcao, mensagem, status, waha_message_id)
  VALUES (p_item_id, p_campaign_id, p_contact_id, p_session_id, 'saida', p_mensagem, 'enviado', p_waha_message_id);
  PERFORM wacrm.increment_campaign_metric(p_campaign_id, 'total_enviados');
END;
$$;

-- These helpers have only service-role callers in the application.
REVOKE ALL ON FUNCTION wacrm.reserve_campaign_tick(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.claim_dispatch_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.complete_dispatch_campaign(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.resume_dispatch_campaign(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.stop_dispatch_campaign(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.mark_queue_item_sent(uuid, uuid, uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.reserve_campaign_tick(uuid), wacrm.claim_dispatch_item(uuid), wacrm.complete_dispatch_campaign(uuid),
  wacrm.mark_queue_item_sent(uuid, uuid, uuid, uuid, text, text, integer),
  wacrm.resume_dispatch_campaign(uuid, uuid), wacrm.stop_dispatch_campaign(uuid, uuid, text) TO service_role;

-- Revoke browser invocation of internal functions without changing legitimate
-- service-role callers. Match existing overloads instead of assuming signatures.
DO $$
DECLARE v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wacrm' AND p.proname IN (
      'increment_unread_count', 'increment_session_page_count', 'recalculate_campaign_metrics',
      'increment_campaign_metric', 'retry_transient_queue_errors', 'claim_queue_item'
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_function.signature);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
