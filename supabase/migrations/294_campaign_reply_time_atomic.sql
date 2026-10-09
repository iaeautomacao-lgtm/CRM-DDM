-- ============================================================
-- 294_campaign_reply_time_atomic.sql   (PRD 11 — F21 e W8)
-- O que faz: wacrm.record_campaign_reply_time(campaign, segundos) atualiza o tempo médio de resposta da campanha
-- NUM ÚNICO UPDATE (a linha de campaign_metrics fica travada até o fim). Antes o código lia a média, calculava e
-- gravava em 3 idas: respostas simultâneas perdiam atualização. n = respostas já contadas (consolidadas + deltas
-- pendentes da migration 183), que já inclui a resposta atual (increment_campaign_metric roda antes).
-- W8 (decisão do dono 09/10): o recibo órfão (sem item de campanha) passa a ser apagado após 48 h, em vez de 7 dias
-- (cleanup_orphan_dispatch_receipts, mesma assinatura e mesmos GRANTs da 159).
-- Sem a migration o app cai no caminho antigo (leitura + gravação), então nada quebra.
-- PRÉ-CHECK: SELECT to_regclass('wacrm.campaign_metrics'), to_regclass('wacrm.campaign_metric_deltas');   -- ambos não nulos
-- VERIFICAÇÃO: SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--              WHERE n.nspname='wacrm' AND proname='record_campaign_reply_time';   -- 1 linha
-- ORDEM: pode ser aplicada antes ou depois do deploy.
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.record_campaign_reply_time(uuid, integer);
--           (W8: reaplicar o corpo da 159 com interval '7 days')
-- ============================================================
BEGIN;

DO $$ BEGIN
  IF to_regclass('wacrm.dispatch_status_receipts') IS NULL OR to_regclass('wacrm.campaign_metrics') IS NULL OR to_regclass('wacrm.campaign_metric_deltas') IS NULL THEN
    RAISE EXCEPTION '294: faltam wacrm.dispatch_status_receipts / wacrm.campaign_metrics / wacrm.campaign_metric_deltas (migration 183)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.record_campaign_reply_time(p_campaign_id uuid, p_elapsed_seconds integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE wacrm.campaign_metrics m
     SET tempo_medio_resposta = CASE
           WHEN n.total <= 1 THEN p_elapsed_seconds
           ELSE round((COALESCE(m.tempo_medio_resposta, 0) * (n.total - 1) + p_elapsed_seconds)::numeric / n.total)::integer
         END
    FROM (
      SELECT COALESCE(mm.total_respostas, 0)
             + COALESCE((SELECT SUM(d.n) FROM wacrm.campaign_metric_deltas d
                          WHERE d.campaign_id = p_campaign_id AND d.field = 'total_respostas'), 0) AS total
        FROM wacrm.campaign_metrics mm WHERE mm.campaign_id = p_campaign_id
    ) n
   WHERE m.campaign_id = p_campaign_id
     AND p_elapsed_seconds > 0;
$$;

REVOKE ALL ON FUNCTION wacrm.record_campaign_reply_time(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.record_campaign_reply_time(uuid, integer) TO service_role;

-- W8: mesma função da 159, com 48 h.
CREATE OR REPLACE FUNCTION wacrm.cleanup_orphan_dispatch_receipts(p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $f$
DECLARE v_deleted integer;
BEGIN
  WITH doomed AS (
    SELECT r.message_id, r.status
    FROM wacrm.dispatch_status_receipts r
    WHERE r.created_at < clock_timestamp() - interval '48 hours'
      AND NOT EXISTS (
        SELECT 1 FROM wacrm.disp_message_queue q WHERE q.waha_message_id = r.message_id
      )
    ORDER BY r.created_at
    LIMIT least(5000, greatest(1, COALESCE(p_limit, 5000)))
  )
  DELETE FROM wacrm.dispatch_status_receipts r
  USING doomed d
  WHERE r.message_id = d.message_id AND r.status = d.status;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$f$;
REVOKE ALL ON FUNCTION wacrm.cleanup_orphan_dispatch_receipts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.cleanup_orphan_dispatch_receipts(integer) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('294_campaign_reply_time_atomic') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
