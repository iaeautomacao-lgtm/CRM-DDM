-- ============================================================
-- 159_dispatch_auto_pause_receipts_cleanup.sql — pausa automática de
-- segurança do disparador + limpeza de recibos de status órfãos.
--
-- Aplicar no Supabase SQL Editor DEPOIS da 158 (a limpeza usa o índice
-- idx_dmq_waha_message_id). Aplicar ANTES do deploy para que a retomada
-- possa reiniciar a janela de avaliação. Sem ela o app loga e segue.
-- Os índices abaixo são transacionais: aplicar fora do pico de disparos.
-- Conferir o schema live antes (CLAUDE.md): wacrm.campaigns e
-- wacrm.dispatch_status_receipts (125/133) precisam existir.
--
-- 1. campaigns.pausa_automatica_motivo / auto_pausa_avaliar_desde
--    O cron (api/disparador/cron → lib/disparador/auto-pause.ts) pausa a
--    campanha com stop_dispatch_campaign(..., 'pause') quando a taxa de erro
--    permanente das últimas tentativas passa do limite, e grava aqui o
--    motivo ("Pausada automaticamente: 42% de erro (código 132000)") para o
--    monitor exibir. Ao retomar, startCampaign limpa o motivo e grava
--    auto_pausa_avaliar_desde = agora: a avaliação recomeça só com as
--    tentativas posteriores à retomada (senão a mesma janela de erros
--    pausaria de novo no tick seguinte).
--
-- 2. wacrm.cleanup_orphan_dispatch_receipts(p_limit)
--    apply_dispatch_status (133) grava um recibo para TODO status da Meta —
--    inclusive de mensagens que não são do disparador (inbox, fluxos, IA).
--    Esses nunca casam com uma linha da fila e ficavam para sempre. A função
--    apaga, em lotes de no máximo 5000, recibos com mais de 7 dias que não
--    correspondem a nenhum item da fila (waha_message_id). Recibo de item
--    real da fila nunca é apagado aqui (o replay continua responsável).
--
-- Idempotente.
-- ============================================================

BEGIN;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS pausa_automatica_motivo text;
ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS auto_pausa_avaliar_desde timestamptz;

COMMENT ON COLUMN wacrm.campaigns.pausa_automatica_motivo IS
  'Motivo da última pausa automática de segurança (cron do disparador); NULL após retomar.';
COMMENT ON COLUMN wacrm.campaigns.auto_pausa_avaliar_desde IS
  'A pausa automática só considera tentativas a partir deste instante (gravado ao retomar).';

-- Janela móvel limitada, sem ordenar a campanha inteira a cada avaliação.
CREATE INDEX IF NOT EXISTS idx_dmq_auto_pause_attempts
  ON wacrm.disp_message_queue (campaign_id, updated_at DESC)
  WHERE tentativas > 0
    AND status IN ('enviado', 'entregue', 'lido', 'erro', 'bloqueado')
    AND (status <> 'erro' OR erro_permanente = true);
-- Índice de dispatch_status_receipts(created_at) para a limpeza: criado sem
-- travar a tabela pela migration 168 (idx_dispatch_status_receipts_created_at,
-- CONCURRENTLY). Sem ele a limpeza só fica mais lenta, não quebra.

CREATE OR REPLACE FUNCTION wacrm.cleanup_orphan_dispatch_receipts(
  p_limit integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_deleted integer;
BEGIN
  WITH doomed AS (
    SELECT r.message_id, r.status
    FROM wacrm.dispatch_status_receipts r
    WHERE r.created_at < clock_timestamp() - interval '7 days'
      AND NOT EXISTS (
        SELECT 1
        FROM wacrm.disp_message_queue q
        WHERE q.waha_message_id = r.message_id
      )
    ORDER BY r.created_at
    LIMIT least(5000, greatest(1, COALESCE(p_limit, 5000)))
  )
  DELETE FROM wacrm.dispatch_status_receipts r
  USING doomed d
  WHERE r.message_id = d.message_id
    AND r.status = d.status;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.cleanup_orphan_dispatch_receipts(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.cleanup_orphan_dispatch_receipts(integer) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
