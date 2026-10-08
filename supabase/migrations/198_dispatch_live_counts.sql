-- ============================================================
-- 198_dispatch_live_counts.sql   (PRD 11, A20/A21 — painéis sem varredura da fila)
--
-- Problema: GET /api/disparador/desempenho/live (polling curto da tela de Desempenho, uma chamada a cada poucos segundos
-- por usuário) fazia CINCO `count: exact` sobre disp_message_queue: fila, em envio, erros, bloqueados (cada um sobre todas as
-- campanhas em execução) e envios dos últimos 60 s por número. Com 100 mil itens isso são cinco varreduras por refresh.
--
-- O que esta migration faz: wacrm.dispatch_live_counts(p_account_id, p_cap) devolve TUDO numa única ida ao banco, com
-- cada contagem LIMITADA a p_cap (padrão 100.000 = o volume de projeto): o custo por refresh tem teto, e o resultado diz
-- quando bateu no teto (`capped`). Abaixo do teto os números são EXATAMENTE os de antes (mesmos predicados):
--   campanhas ativas : campaigns da conta com status 'em_execucao' (até 1000);
--   queued           : status IN (agendado, pendente, pausado) nessas campanhas;
--   sending          : status 'enviando';  errors: 'erro';  blocked: 'bloqueado';
--   sent_last_60s    : sent_at >= agora - 60 s nos números HABILITADOS da conta (índice (session_id, sent_at)).
-- Só lê dados da conta pedida (campanhas e números filtrados por account_id).
--
-- O total do detalhamento por métrica da campanha (queue-details) NÃO precisa de função nova: usa get_campaign_stats
-- (075) — uma agregação por status — no lugar do `count: exact` junto da página.
--
-- COMPATIBILIDADE: sem a função (PGRST202/42883) o endpoint usa as contagens de antes. Pode ser aplicada ANTES ou DEPOIS do deploy.
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.disp_message_queue'), to_regclass('wacrm.campaigns'), to_regclass('wacrm.whatsapp_config');  -- não nulos
--   SELECT to_regprocedure('wacrm.dispatch_live_counts(uuid,integer)');                                                    -- NULL antes
--   SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND tablename='disp_message_queue' ORDER BY 1;               -- guarde a lista
-- DEPOIS: a 198b (índice parcial/paginação, CONCURRENTLY, SOZINHA) é opcional — ver o cabeçalho dela.
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.dispatch_live_counts(uuid, integer);
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL
     OR to_regclass('wacrm.campaigns') IS NULL
     OR to_regclass('wacrm.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION '198: faltam disp_message_queue / campaigns / whatsapp_config';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.dispatch_live_counts(p_account_id uuid, p_cap integer DEFAULT 100000)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cap       integer := GREATEST(COALESCE(p_cap, 100000), 1);
  v_campaigns uuid[];
  v_channels  uuid[];
  v_queued    integer;
  v_sending   integer;
  v_errors    integer;
  v_blocked   integer;
  v_sent60    integer;
BEGIN
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_campaigns FROM (
    SELECT c.id FROM wacrm.campaigns c
    WHERE c.account_id = p_account_id AND c.status = 'em_execucao' LIMIT 1000
  ) s;
  SELECT COALESCE(array_agg(w.id), ARRAY[]::uuid[]) INTO v_channels
  FROM wacrm.whatsapp_config w
  WHERE w.account_id = p_account_id AND w.habilitado = true;

  -- Cada contagem para em v_cap + 1 linhas (teto de custo); o resultado é min(contagem, v_cap) e `capped` avisa.
  SELECT count(*) INTO v_queued FROM (
    SELECT 1 FROM wacrm.disp_message_queue q
    WHERE q.campaign_id = ANY (v_campaigns) AND q.status IN ('agendado', 'pendente', 'pausado') LIMIT v_cap + 1) s;
  SELECT count(*) INTO v_sending FROM (
    SELECT 1 FROM wacrm.disp_message_queue q
    WHERE q.campaign_id = ANY (v_campaigns) AND q.status = 'enviando' LIMIT v_cap + 1) s;
  SELECT count(*) INTO v_errors FROM (
    SELECT 1 FROM wacrm.disp_message_queue q
    WHERE q.campaign_id = ANY (v_campaigns) AND q.status = 'erro' LIMIT v_cap + 1) s;
  SELECT count(*) INTO v_blocked FROM (
    SELECT 1 FROM wacrm.disp_message_queue q
    WHERE q.campaign_id = ANY (v_campaigns) AND q.status = 'bloqueado' LIMIT v_cap + 1) s;
  SELECT count(*) INTO v_sent60 FROM (
    SELECT 1 FROM wacrm.disp_message_queue q
    WHERE q.session_id = ANY (v_channels) AND q.sent_at >= clock_timestamp() - interval '60 seconds' LIMIT v_cap + 1) s;

  RETURN jsonb_build_object(
    'active_campaigns', cardinality(v_campaigns),
    'queued', LEAST(v_queued, v_cap),
    'sending', LEAST(v_sending, v_cap),
    'errors', LEAST(v_errors, v_cap),
    'blocked', LEAST(v_blocked, v_cap),
    'sent_last_60s', LEAST(v_sent60, v_cap),
    'cap', v_cap,
    'capped', jsonb_build_object(
      'queued', v_queued > v_cap, 'sending', v_sending > v_cap, 'errors', v_errors > v_cap,
      'blocked', v_blocked > v_cap, 'sent_last_60s', v_sent60 > v_cap)
  );
END;
$$;

REVOKE ALL ON FUNCTION wacrm.dispatch_live_counts(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.dispatch_live_counts(uuid, integer) TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('198_dispatch_live_counts') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
