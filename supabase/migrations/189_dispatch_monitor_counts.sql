-- ============================================================
-- 189_dispatch_monitor_counts.sql
--
-- Contagens do Monitor ao vivo (GET /api/disparador/monitor/snapshot) numa ÚNICA ida ao banco, sem
-- nenhum count(*) livre sobre a fila de 100 mil itens:
--   por número  : envios no último 1/5 min (índice (session_id, sent_at)), itens 'enviando' (índice
--                 parcial de em voo) e "na fila" LIMITADO a 10.001 (precisa do índice da 189b; sem ele
--                 o campo vem NULL — nunca varre a fila inteira);
--   por campanha: envios no último 1/5 min (índice (campaign_id, sent_at));
--   erros       : itens em erro dos últimos N min por campanha e por erro_codigo (coluna da 187; sem ela
--                 agrupa tudo como "sem código").
-- Escopo: confere que os números e campanhas pedidos pertencem a p_account_id (nada de outra conta sai).
--
-- PRÉ-CHECK: SELECT to_regclass('wacrm.disp_message_queue'), to_regclass('wacrm.whatsapp_config'),
--                   to_regclass('wacrm.campaigns');   -- todos não nulos
-- ORDEM: pode ser aplicada antes ou depois do deploy (o app tem alternativa sem a função, com menos
-- detalhes). Depois, rode a 189b (índice CONCURRENTLY, sozinha).
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL
     OR to_regclass('wacrm.whatsapp_config') IS NULL
     OR to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '189: faltam disp_message_queue / whatsapp_config / campaigns';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.dispatch_monitor_counts(
  p_account_id uuid,
  p_sessions uuid[],
  p_campaigns uuid[],
  p_errors_minutes integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_since     timestamptz := clock_timestamp() - pg_catalog.make_interval(mins => GREATEST(COALESCE(p_errors_minutes, 15), 1));
  v_has_idx   boolean := to_regclass('wacrm.idx_dmq_session_agendado') IS NOT NULL;
  v_has_code  boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'wacrm' AND table_name = 'disp_message_queue' AND column_name = 'erro_codigo'
  );
  v_campaigns uuid[];
  v_sessions  jsonb;
  v_camp      jsonb;
  v_errors    jsonb;
BEGIN
  -- Só campanhas desta conta.
  SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_campaigns
  FROM wacrm.campaigns c
  WHERE c.id = ANY (COALESCE(p_campaigns, ARRAY[]::uuid[])) AND c.account_id = p_account_id;

  -- Por número (só os desta conta).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'session_id', s.id,
    'sent_1m', (SELECT count(*) FROM wacrm.disp_message_queue q
                WHERE q.session_id = s.id AND q.sent_at >= clock_timestamp() - interval '1 minute'),
    'sent_5m', (SELECT count(*) FROM wacrm.disp_message_queue q
                WHERE q.session_id = s.id AND q.sent_at >= clock_timestamp() - interval '5 minutes'),
    'in_flight', (SELECT count(*) FROM wacrm.disp_message_queue q
                  WHERE q.session_id = s.id AND q.status = 'enviando'),
    'queued', CASE WHEN v_has_idx THEN
                (SELECT count(*) FROM (
                   SELECT 1 FROM wacrm.disp_message_queue q
                   WHERE q.session_id = s.id AND q.status = 'agendado'
                   LIMIT 10001) capped)
              END
  )), '[]'::jsonb) INTO v_sessions
  FROM wacrm.whatsapp_config s
  WHERE s.id = ANY (COALESCE(p_sessions, ARRAY[]::uuid[])) AND s.account_id = p_account_id;

  -- Por campanha: ritmo recente.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'campaign_id', c.id,
    'sent_1m', (SELECT count(*) FROM wacrm.disp_message_queue q
                WHERE q.campaign_id = c.id AND q.sent_at >= clock_timestamp() - interval '1 minute'),
    'sent_5m', (SELECT count(*) FROM wacrm.disp_message_queue q
                WHERE q.campaign_id = c.id AND q.sent_at >= clock_timestamp() - interval '5 minutes')
  )), '[]'::jsonb) INTO v_camp
  FROM wacrm.campaigns c
  WHERE c.id = ANY (v_campaigns);

  -- Erros recentes por campanha e por código.
  IF v_has_code THEN
    EXECUTE $q$
      SELECT COALESCE(jsonb_agg(jsonb_build_object('campaign_id', e.campaign_id, 'erro_codigo', e.erro_codigo, 'n', e.n)), '[]'::jsonb)
      FROM (
        SELECT q.campaign_id, q.erro_codigo, count(*)::integer AS n
        FROM wacrm.disp_message_queue q
        WHERE q.campaign_id = ANY ($1) AND q.status = 'erro' AND q.updated_at >= $2
        GROUP BY q.campaign_id, q.erro_codigo
      ) e
    $q$ INTO v_errors USING v_campaigns, v_since;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('campaign_id', e.campaign_id, 'erro_codigo', NULL, 'n', e.n)), '[]'::jsonb)
    INTO v_errors
    FROM (
      SELECT q.campaign_id, count(*)::integer AS n
      FROM wacrm.disp_message_queue q
      WHERE q.campaign_id = ANY (v_campaigns) AND q.status = 'erro' AND q.updated_at >= v_since
      GROUP BY q.campaign_id
    ) e;
  END IF;

  RETURN jsonb_build_object(
    'sessions', v_sessions,
    'campaigns', v_camp,
    'errors', v_errors,
    'has_queue_index', v_has_idx,
    'has_error_code', v_has_code
  );
END;
$$;

REVOKE ALL ON FUNCTION wacrm.dispatch_monitor_counts(uuid, uuid[], uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.dispatch_monitor_counts(uuid, uuid[], uuid[], integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
