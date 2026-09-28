-- Migration 112: RPC de recálculo de campaign_metrics a partir de
-- disp_message_queue — corrige o drift que increment_campaign_metric
-- (soma incremental, ver disparador_schema.sql) acumula sempre que um
-- caminho de escrita esquece de chamá-la. Exemplos reais já
-- identificados: erros síncronos de envio em processQueue.ts nunca
-- incrementavam total_erros (só o webhook assíncrono de status da Meta
-- fazia isso), e o bloqueio por blacklist não incrementava
-- total_blacklist — ambos corrigidos separadamente (ver processQueue.ts),
-- mas o drift já acumulado em campanhas antigas só se resolve recontando
-- do zero.
--
-- total_respostas e tempo_medio_resposta ficam de fora de propósito —
-- vêm de uma fonte diferente (respostas do cliente, ver
-- src/lib/disparador/reply-tracker.ts), não do status de
-- disp_message_queue, então não são deriváveis por essa tabela.
--
-- Só cria/substitui a função — não altera nenhuma linha existente de
-- campaign_metrics até ser chamada explicitamente (ver Fix 2 em
-- src/app/api/disparador/cron/route.ts). Idempotente — safe pra rodar
-- mais de uma vez. APLICAR MANUALMENTE no Supabase SQL Editor antes do
-- deploy.

CREATE OR REPLACE FUNCTION wacrm.recalculate_campaign_metrics(p_campaign_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE wacrm.campaign_metrics
  SET
    total_enviados   = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status IN ('enviado','entregue','lido')),
    total_entregues  = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status IN ('entregue','lido')),
    total_lidos      = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status = 'lido'),
    total_erros      = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status = 'erro'),
    total_blacklist  = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status = 'bloqueado'),
    updated_at       = NOW()
  WHERE campaign_id = p_campaign_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public, extensions;
