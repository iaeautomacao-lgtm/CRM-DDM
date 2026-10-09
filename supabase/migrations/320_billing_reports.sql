-- ============================================================
-- 320_billing_reports.sql   (PRD 17, PR 17.6 — métricas "pago após cobrança", relatório por período e dados para alertas da régua)
--
--   billing_ruler_report(account, ruler, from, to)   relatório SOMENTE LEITURA de uma régua num período (datas de Brasília, máx. 93 dias):
--        por etapa: enviadas, entregues, lidas, RESPONDIDAS (cliente escreveu em até 3 dias depois do envio), com erro, e PAGAS APÓS COBRANÇA;
--        totais; "cobranças até o pagamento" (média e distribuição); série diária (enviadas × pagas após cobrança).
--   billing_alert_stats(account)                     contagens para os alertas: etapas 'reserved' paradas há > 15 min, última sincronização por fonte,
--        réguas ligadas (fora do dry-run) e o canal de cada uma — a decisão de "alerta" e o limiar ficam no código (src/lib/billing/alerts.ts).
--
-- DEFINIÇÕES (o que o número significa — a tela deve dizer o mesmo):
--   enviada            etapa com status sent|delivered|read, pelo horário de envio da fila (sent_at; sem ele, a atualização do registro)
--   entregue / lida    status delivered|read / read
--   respondida         existe mensagem do CLIENTE (sender_type = 'customer') em conversa do contato entre o envio e 3 dias depois
--   paga após cobrança inscrição parada com motivo 'paid' CUJO pagamento foi detectado (stopped_at) DEPOIS de pelo menos uma etapa enviada. É o
--                      momento em que o sistema VIU o pagamento (sincronização/consulta pré-envio), não a data do pagamento na DDM. Atribuída à
--                      ÚLTIMA etapa enviada antes dela. "Correlação, não causa": quem pagaria de qualquer jeito também entra.
--   paga sem cobrança  parada por 'paid' sem nenhuma etapa enviada antes (o pagamento veio antes da régua cobrar)
-- Não guarda nem devolve dado pessoal: só contagens e ids de etapa. Fechadas ao service_role (as rotas checam billing.view).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.billing_step_sends'), to_regclass('wacrm.billing_enrollments'), to_regclass('wacrm.billing_sync_state'),
--                    to_regclass('wacrm.conversations'), to_regclass('wacrm.messages'), to_regclass('wacrm.disp_message_queue');   -- todos não nulos
-- ORDEM: depois da 279. Antes ou depois do deploy (sem ela, relatório e alertas respondem 503 / indisponível). Idempotente.
-- ROLLBACK:   BEGIN; DROP FUNCTION IF EXISTS wacrm.billing_ruler_report(uuid, uuid, date, date), wacrm.billing_alert_stats(uuid);
--             DELETE FROM wacrm.schema_migrations WHERE version = '320_billing_reports'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.billing_step_sends') IS NULL OR to_regclass('wacrm.billing_enrollments') IS NULL OR to_regclass('wacrm.billing_sync_state') IS NULL THEN
    RAISE EXCEPTION '320: faltam as tabelas da régua (migrations 270–275)';
  END IF;
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.messages') IS NULL OR to_regclass('wacrm.disp_message_queue') IS NULL THEN
    RAISE EXCEPTION '320: faltam conversations/messages/disp_message_queue — confira o schema vivo';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.billing_ruler_report(p_account uuid, p_ruler uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
    RAISE EXCEPTION 'range_invalid';
  END IF;
  PERFORM 1 FROM wacrm.billing_rulers WHERE id = p_ruler AND account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'ruler_not_found'; END IF;
  v_from := p_from::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_to   := (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  RETURN (
    WITH sends AS MATERIALIZED (
      -- uma passada pelos envios do período (enviados ou com erro), com o horário de envio e a flag "respondida"
      SELECT x.step_id, x.status, t.at,
             (x.status IN ('sent', 'delivered', 'read') AND EXISTS (
                SELECT 1 FROM wacrm.conversations c
                  JOIN wacrm.messages m ON m.conversation_id = c.id
                 WHERE c.contact_id = x.contact_id AND c.account_id = p_account
                   AND m.sender_type = 'customer' AND m.created_at > t.at AND m.created_at <= t.at + interval '3 days')) AS replied
        FROM wacrm.billing_step_sends x
        JOIN wacrm.billing_ruler_steps s ON s.id = x.step_id AND s.ruler_id = p_ruler AND s.account_id = p_account
        LEFT JOIN wacrm.disp_message_queue q ON q.id = x.queue_item_id
        CROSS JOIN LATERAL (SELECT coalesce(q.sent_at, x.updated_at) AS at) t
       WHERE x.account_id = p_account AND x.status IN ('sent', 'delivered', 'read', 'error')
         AND t.at >= v_from AND t.at < v_to
    ), paid AS MATERIALIZED (
      -- inscrições pagas no período e a última etapa enviada antes da detecção do pagamento
      SELECT en.id AS enrollment_id, en.stopped_at, ls.step_id AS last_step, coalesce(ls.charges, 0) AS charges
        FROM wacrm.billing_enrollments en
        LEFT JOIN LATERAL (
          SELECT (array_agg(z.step_id ORDER BY z.at DESC))[1] AS step_id, count(*)::integer AS charges
            FROM (SELECT x.step_id, coalesce(q.sent_at, x.updated_at) AS at
                    FROM wacrm.billing_step_sends x LEFT JOIN wacrm.disp_message_queue q ON q.id = x.queue_item_id
                   WHERE x.enrollment_id = en.id AND x.status IN ('sent', 'delivered', 'read')) z
           WHERE z.at < en.stopped_at) ls ON true
       WHERE en.account_id = p_account AND en.ruler_id = p_ruler AND en.status = 'stopped' AND en.stop_reason = 'paid'
         AND en.stopped_at >= v_from AND en.stopped_at < v_to
    )
    SELECT jsonb_build_object(
      'ruler_id', p_ruler, 'from', p_from, 'to', p_to,
      'steps', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'step_id', s.id, 'position', s.position, 'offset_days', s.offset_days, 'active', s.active,
                 'sent', coalesce(a.sent, 0), 'delivered', coalesce(a.delivered, 0), 'read', coalesce(a.read, 0),
                 'replied', coalesce(a.replied, 0), 'errors', coalesce(a.errors, 0), 'paid_after', coalesce(pd.paid, 0)) ORDER BY s.position)
          FROM wacrm.billing_ruler_steps s
          LEFT JOIN (SELECT step_id,
                            count(*) FILTER (WHERE status IN ('sent', 'delivered', 'read')) AS sent,
                            count(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
                            count(*) FILTER (WHERE status = 'read') AS read,
                            count(*) FILTER (WHERE replied) AS replied,
                            count(*) FILTER (WHERE status = 'error') AS errors
                       FROM sends GROUP BY step_id) a ON a.step_id = s.id
          LEFT JOIN (SELECT last_step, count(*) AS paid FROM paid WHERE last_step IS NOT NULL GROUP BY last_step) pd ON pd.last_step = s.id
         WHERE s.ruler_id = p_ruler AND s.account_id = p_account), '[]'::jsonb),
      'totals', (SELECT jsonb_build_object(
                   'sent', count(*) FILTER (WHERE status IN ('sent', 'delivered', 'read')),
                   'delivered', count(*) FILTER (WHERE status IN ('delivered', 'read')),
                   'read', count(*) FILTER (WHERE status = 'read'),
                   'replied', count(*) FILTER (WHERE replied),
                   'errors', count(*) FILTER (WHERE status = 'error')) FROM sends),
      'payments', (SELECT jsonb_build_object(
                     'paid_after_charge', count(*) FILTER (WHERE last_step IS NOT NULL),
                     'paid_without_charge', count(*) FILTER (WHERE last_step IS NULL),
                     'avg_charges_before_payment', round(avg(charges) FILTER (WHERE last_step IS NOT NULL)::numeric, 2),
                     'by_charges', coalesce((SELECT jsonb_agg(jsonb_build_object('charges', c.charges, 'total', c.n) ORDER BY c.charges)
                                               FROM (SELECT charges, count(*) AS n FROM paid WHERE last_step IS NOT NULL GROUP BY charges) c), '[]'::jsonb)) FROM paid),
      'daily', coalesce((
        SELECT jsonb_agg(jsonb_build_object('day', d.day, 'sent', d.sent, 'paid_after', d.paid) ORDER BY d.day)
          FROM (SELECT coalesce(a.day, b.day) AS day, coalesce(a.sent, 0) AS sent, coalesce(b.paid, 0) AS paid
                  FROM (SELECT (at AT TIME ZONE 'America/Sao_Paulo')::date AS day, count(*) AS sent FROM sends WHERE status IN ('sent', 'delivered', 'read') GROUP BY 1) a
                  FULL JOIN (SELECT (stopped_at AT TIME ZONE 'America/Sao_Paulo')::date AS day, count(*) AS paid FROM paid WHERE last_step IS NOT NULL GROUP BY 1) b ON b.day = a.day) d), '[]'::jsonb))
  );
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.billing_alert_stats(p_account uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = wacrm, public
AS $$
  SELECT jsonb_build_object(
    'reserved_stuck', (SELECT count(*) FROM wacrm.billing_step_sends WHERE account_id = p_account AND status = 'reserved' AND reserved_at < now() - interval '15 minutes'),
    'oldest_reserved_s', (SELECT floor(extract(epoch FROM now() - min(reserved_at)))::bigint FROM wacrm.billing_step_sends WHERE account_id = p_account AND status = 'reserved'),
    'sync', coalesce((SELECT jsonb_agg(jsonb_build_object('source', source, 'last_success_at', last_success_at, 'last_run_at', last_run_at, 'last_error', last_error) ORDER BY source)
                        FROM wacrm.billing_sync_state WHERE account_id = p_account), '[]'::jsonb),
    'live_rulers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'channel_id', channel_id) ORDER BY priority, name)
                               FROM wacrm.billing_rulers WHERE account_id = p_account AND active AND NOT dry_run), '[]'::jsonb),
    'open_debts', (SELECT count(*) FROM wacrm.billing_debts WHERE account_id = p_account AND status = 'open'))
$$;

REVOKE ALL ON FUNCTION wacrm.billing_ruler_report(uuid, uuid, date, date), wacrm.billing_alert_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.billing_ruler_report(uuid, uuid, date, date), wacrm.billing_alert_stats(uuid) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('320_billing_reports') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
