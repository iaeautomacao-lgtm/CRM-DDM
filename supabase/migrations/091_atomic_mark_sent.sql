-- Migration 091: atomiza a sequência de escritas pós-envio no Disparador.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- processQueueItem (src/lib/disparador/processQueue.ts) fazia 3 escritas
-- sequenciais sem transação após um envio bem-sucedido: UPDATE
-- disp_message_queue (status='enviado') -> INSERT message_logs -> RPC
-- increment_campaign_metric. Se o processo morresse/reiniciasse entre a
-- 1ª e a 3ª (deploy, crash), a mensagem já ficava marcada 'enviado'
-- corretamente, mas message_logs perdia a linha de auditoria e/ou
-- campaign_metrics.total_enviados nunca incrementava — sem nenhum job
-- de reconciliação pra corrigir depois. campanhas/page.tsx usa esse
-- contador como denominador das taxas de entrega/leitura/resposta
-- exibidas na UI, então o drift é visível pro negócio, não só interno.
--
-- Reaproveita wacrm.increment_campaign_metric (já existe, ver
-- disparador_schema.sql) em vez de duplicar a lógica de incremento —
-- chamar uma função de dentro da outra mantém as 3 escritas na mesma
-- transação implícita da chamada RPC.
CREATE OR REPLACE FUNCTION wacrm.mark_queue_item_sent(
  p_item_id uuid,
  p_campaign_id uuid,
  p_contact_id uuid,
  p_session_id uuid,
  p_mensagem text,
  p_waha_message_id text,
  p_tentativas integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'wacrm', 'public'
AS $$
BEGIN
  -- Mesmos campos do UPDATE original — NÃO seta updated_at: essa coluna
  -- já é sabidamente não-mantida em disp_message_queue (nenhum trigger
  -- a atualiza), sent_at é o campo confiável pra "quando foi enviado".
  -- Não introduzir esse side-effect aqui, fora do escopo desta correção.
  UPDATE wacrm.disp_message_queue
  SET status = 'enviado',
      sent_at = now(),
      waha_message_id = p_waha_message_id,
      tentativas = p_tentativas
  WHERE id = p_item_id;

  INSERT INTO wacrm.message_logs (
    queue_id, campaign_id, contact_id, session_id,
    direcao, mensagem, status, waha_message_id
  ) VALUES (
    p_item_id, p_campaign_id, p_contact_id, p_session_id,
    'saida', p_mensagem, 'enviado', p_waha_message_id
  );

  PERFORM wacrm.increment_campaign_metric(p_campaign_id, 'total_enviados');
END;
$$;
