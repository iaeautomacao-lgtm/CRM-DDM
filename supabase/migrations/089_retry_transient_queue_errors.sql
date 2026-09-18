-- Migration 089: retry automático de erros transitórios na fila do Disparador.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- status='erro' AND erro_permanente=false ficava preso pra sempre: o claim
-- (claimItemAtomically / RPC claim_queue_item, migration 075) só seleciona
-- status='agendado', e nada em processQueue.ts jamais reagendava um item
-- de volta de 'erro' pra 'agendado'. MAX_TENTATIVAS/tentativas existiam no
-- schema mas eram código morto na prática — confirmado que nenhum item
-- real chegava numa segunda tentativa. Esta RPC é chamada uma vez por tick
-- do cron (ver src/app/api/disparador/cron/route.ts), antes do loop de
-- processamento normal, e reagenda com backoff exponencial (tentativas^2
-- minutos: 1min, 4min, 9min, 16min) só itens de campanhas ainda em
-- execução — uma campanha pausada/encerrada não deve reviver itens de
-- erro sozinha.
CREATE OR REPLACE FUNCTION wacrm.retry_transient_queue_errors()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE wacrm.disp_message_queue
  SET
    status = 'agendado',
    -- backoff exponencial: 1min, 4min, 9min, 16min (tentativas 1,2,3,4)
    scheduled_at = now() + (tentativas * tentativas * interval '1 minute'),
    updated_at = now()
  WHERE
    status = 'erro'
    AND erro_permanente = false
    AND tentativas < 5
    -- sent_at é null pra itens nunca enviados (falharam antes do envio) —
    -- COALESCE cai pra created_at nesse caso, senão nunca ficariam
    -- elegíveis pro retry.
    AND COALESCE(sent_at, created_at) < now() - interval '5 minutes'
    -- só retenta de campanhas ainda em execução — evita reviver itens de
    -- campanha pausada/encerrada.
    AND campaign_id IN (
      SELECT id FROM wacrm.campaigns WHERE status = 'em_execucao'
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
