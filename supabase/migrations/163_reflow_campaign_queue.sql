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
-- tocado. Retorna quantas linhas foram atualizadas.
--
-- ORDEM: aplicar ANTES do deploy. Sem a função o app usa um fallback item a
-- item (mesmo filtro), bem mais lento em filas grandes.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION wacrm.reflow_campaign_queue(p_campaign_id uuid, p_items jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM 1 FROM wacrm.campaigns WHERE id = p_campaign_id FOR UPDATE;

  UPDATE wacrm.disp_message_queue q
     SET scheduled_at = r.scheduled_at
    FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb)) AS r(id uuid, scheduled_at timestamptz)
   WHERE q.id = r.id
     AND q.campaign_id = p_campaign_id
     AND q.status = 'agendado'
     AND r.scheduled_at IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.reflow_campaign_queue(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.reflow_campaign_queue(uuid, jsonb) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
