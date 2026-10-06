-- ============================================================
-- 163_reflow_campaign_queue.sql
--
-- wacrm.reflow_campaign_queue(p_campaign_id, p_items): grava de uma vez o
-- novo scheduled_at de um lote de itens da fila de uma campanha. Usada pelo
-- cron do disparador (src/lib/disparador/queue-reflow.ts) para
-- redistribuir na janela de envio a fila de campanhas em lote/"Segmentado"
-- montadas antes do relógio de janela (PR #75), sem a rajada na reabertura
-- e sem empurrar itens por dias.
--
-- p_items = [{"id": "<uuid>", "scheduled_at": "<timestamptz>"}, ...]
-- (o app manda em pedaços de 500).
--
-- Concorrência: trava a campanha (mesmo FOR UPDATE do claim_dispatch_item)
-- e só altera itens ainda 'agendado' da própria campanha — item já
-- reivindicado ('enviando'), pausado ou cancelado no meio do caminho não é
-- tocado. Retorna quantas linhas foram atualizadas. p_status = 'pausado'
-- é usado na retomada (abaixo).
--
-- wacrm.resume_dispatch_campaign_keep_schedule(p_campaign_id, p_account_id):
-- igual a resume_dispatch_campaign, mas sem pôr scheduled_at = agora em
-- todos os itens. Na retomada de campanha em lote o app grava antes o ritmo
-- nos itens 'pausado' e retoma com esta função (startCampaign.ts).
--
-- ORDEM: aplicar ANTES do deploy. Sem a função o app usa um fallback item a
-- item (mesmo filtro), bem mais lento em filas grandes.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

-- Versão de 2 parâmetros (rascunho desta migration) ficaria ambígua com a
-- de 3 com DEFAULT.
DROP FUNCTION IF EXISTS wacrm.reflow_campaign_queue(uuid, jsonb);

CREATE OR REPLACE FUNCTION wacrm.reflow_campaign_queue(
  p_campaign_id uuid,
  p_items jsonb,
  p_status text DEFAULT 'agendado'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  -- 'pausado': retomada de campanha em lote (ritmo gravado antes de
  -- reativar os itens). Nenhum outro status pode ser reagendado.
  IF p_status IS NULL OR p_status NOT IN ('agendado', 'pausado') THEN
    RAISE EXCEPTION 'reflow_campaign_queue: status inválido %', p_status;
  END IF;

  PERFORM 1 FROM wacrm.campaigns WHERE id = p_campaign_id FOR UPDATE;

  UPDATE wacrm.disp_message_queue q
     SET scheduled_at = r.scheduled_at
    FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb)) AS r(id uuid, scheduled_at timestamptz)
   WHERE q.id = r.id
     AND q.campaign_id = p_campaign_id
     AND q.status = p_status
     AND r.scheduled_at IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.reflow_campaign_queue(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.reflow_campaign_queue(uuid, jsonb, text) TO service_role;

-- Retomada que preserva o scheduled_at já redistribuído (queue-reflow.ts →
-- resumeBatchedCampaign). Igual a resume_dispatch_campaign (133), exceto
-- que não põe scheduled_at = agora em todos os itens — era isso que fazia a
-- fila inteira de uma campanha em lote vencer junto na retomada.
CREATE OR REPLACE FUNCTION wacrm.resume_dispatch_campaign_keep_schedule(
  p_campaign_id uuid,
  p_account_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_count integer;
BEGIN
  SELECT status INTO v_status
  FROM wacrm.campaigns
  WHERE id = p_campaign_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'pausada' THEN RETURN NULL; END IF;

  UPDATE wacrm.disp_message_queue
  SET status = 'agendado',
      scheduled_at = COALESCE(scheduled_at, clock_timestamp())
  WHERE campaign_id = p_campaign_id
    AND status = 'pausado';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE wacrm.campaigns
  SET status = 'em_execucao',
      next_batch_at = NULL
  WHERE id = p_campaign_id;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.resume_dispatch_campaign_keep_schedule(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.resume_dispatch_campaign_keep_schedule(uuid, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
