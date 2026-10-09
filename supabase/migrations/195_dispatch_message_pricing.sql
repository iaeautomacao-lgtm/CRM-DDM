-- ============================================================
-- 195_dispatch_message_pricing.sql   (PRD 11 — custo Meta por categoria, por envio)
--
-- A Meta cobra por mensagem de template (categoria: marketing / utility / authentication / service…) e informa isso no webhook de
-- status: `statuses[].pricing = { billable, pricing_model, category, type }`. Até aqui o app descartava esse objeto — não havia
-- como saber quanto uma campanha ou um número custou. Esta migration guarda o pricing POR ENVIO e soma por campanha/número.
--
--   wacrm.dispatch_message_pricing   uma linha por message_id (wamid) — o 1º pricing recebido vale (a Meta repete o mesmo objeto em
--                                    sent/delivered/read). Tabela FECHADA: RLS ligada sem policy, só service_role.
--   wacrm.record_message_pricing()   ingestão em lote (o webhook chama 1×/POST, depois do 200; idempotente).
--   wacrm.dispatch_cost_summary()    soma mensagens por campanha × número × categoria × cobrável (Desempenho).
--
-- A tabela é independente da fila (join por waha_message_id, índice idx_dmq_waha_message_id da 158): o pricing pode chegar ANTES do app
-- marcar o envio como enviado sem se perder. Valor em reais NÃO é calculado aqui (a tarifa muda por país/moeda/vigência): o painel
-- recebe CONTAGENS por categoria e multiplica pela tabela de preços vigente da conta.
--
-- COMPATIBILIDADE: o app detecta a ausência da migration (42P01/PGRST202/42883) e segue sem gravar/mostrar custo. Pode ser aplicada
-- ANTES ou DEPOIS do deploy. Sem índice CONCURRENTLY (tabela nova, vazia).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.dispatch_message_pricing');   -- NULL
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.dispatch_cost_summary(uuid, uuid, timestamptz, integer);
--             DROP FUNCTION IF EXISTS wacrm.record_message_pricing(jsonb);
--             DROP TABLE IF EXISTS wacrm.dispatch_message_pricing;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL OR to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '195: faltam wacrm.disp_message_queue / wacrm.campaigns';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_message_pricing (
  message_id    text        PRIMARY KEY,
  account_id    uuid        NOT NULL,
  channel_id    uuid,
  category      text        NOT NULL DEFAULT 'unknown',
  pricing_type  text,
  pricing_model text,
  billable      boolean     NOT NULL DEFAULT false,
  event_ts      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE wacrm.dispatch_message_pricing IS
  'Pricing da Meta por mensagem (webhook de status): categoria e se é cobrável. Fechada (service_role). Soma: dispatch_cost_summary().';

-- Painel por número/período e retenção futura.
CREATE INDEX IF NOT EXISTS idx_dispatch_message_pricing_account
  ON wacrm.dispatch_message_pricing (account_id, created_at DESC);

ALTER TABLE wacrm.dispatch_message_pricing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.dispatch_message_pricing FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.dispatch_message_pricing TO service_role;

-- ---------- ingestão em lote ----------
CREATE OR REPLACE FUNCTION wacrm.record_message_pricing(p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN RETURN 0; END IF;

  WITH ins AS (
    INSERT INTO wacrm.dispatch_message_pricing(message_id, account_id, channel_id, category, pricing_type, pricing_model, billable, event_ts)
    SELECT e.message_id, e.account_id, e.channel_id, COALESCE(NULLIF(e.category, ''), 'unknown'), e.pricing_type, e.pricing_model,
           COALESCE(e.billable, false), to_timestamp(e.ts)
    FROM jsonb_to_recordset(p_events) AS e(
      message_id text, account_id uuid, channel_id uuid, category text, pricing_type text, pricing_model text, billable boolean, ts double precision
    )
    WHERE e.message_id IS NOT NULL AND e.message_id <> '' AND e.account_id IS NOT NULL
    ON CONFLICT (message_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_inserted FROM ins;

  RETURN COALESCE(v_inserted, 0);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.record_message_pricing(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.record_message_pricing(jsonb) TO service_role;

-- ---------- soma por campanha × número × categoria ----------
-- p_campaign_id NULL = todas as campanhas da conta; p_since NULL = sem corte de data (created_at do pricing).
-- Devolve um array jsonb [{campaign_id, channel_id, category, billable, messages}], no máximo p_limit linhas (maiores primeiro).
CREATE OR REPLACE FUNCTION wacrm.dispatch_cost_summary(
  p_account_id uuid,
  p_campaign_id uuid DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.messages DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT q.campaign_id,
           q.session_id AS channel_id,
           p.category,
           p.billable,
           count(*)::integer AS messages
    FROM wacrm.dispatch_message_pricing p
    JOIN wacrm.disp_message_queue q ON q.waha_message_id = p.message_id
    JOIN wacrm.campaigns c ON c.id = q.campaign_id AND c.account_id = p_account_id
    WHERE p.account_id = p_account_id
      AND (p_campaign_id IS NULL OR q.campaign_id = p_campaign_id)
      AND (p_since IS NULL OR p.created_at >= p_since)
    GROUP BY q.campaign_id, q.session_id, p.category, p.billable
    ORDER BY count(*) DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 5000))
  ) r;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.dispatch_cost_summary(uuid, uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.dispatch_cost_summary(uuid, uuid, timestamptz, integer) TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('195_dispatch_message_pricing') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
