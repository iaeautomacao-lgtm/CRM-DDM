-- 377_dashboard_costs.sql
-- V1: custo mensal estimado de IA (tokens efetivamente informados pelo provedor)
-- e mensagens Meta (status de entrega verificado + tarifa configurada).
-- Valores NAO equivalem a fatura: impostos, moedas, cotas gratis,
-- descontos por volume, provedores intermediarios e metadados ausentes
-- requerem reconciliacao externa. Nenhum preco e inventado.
-- PRE-CHECK: verificar wacrm.accounts, messages, conversations,
-- whatsapp_config, webhook_status_inbox e a RPC ingest_status_events(jsonb).
-- Ordem: aplicar ANTES do deploy do codigo deste PR.
BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL
     OR to_regclass('wacrm.messages') IS NULL
     OR to_regclass('wacrm.conversations') IS NULL
     OR to_regclass('wacrm.whatsapp_config') IS NULL
     OR to_regclass('wacrm.webhook_status_inbox') IS NULL
     OR to_regprocedure('wacrm.ingest_status_events(jsonb)') IS NULL THEN
    RAISE EXCEPTION '377: prerequisitos V1 ausentes; revisar migrations anteriores';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.cost_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ai','meta')),
  sku text NOT NULL CHECK (length(sku) BETWEEN 2 AND 128),
  effective_from date NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USD','BRL')),
  input_per_million numeric(20,8),
  cached_input_per_million numeric(20,8),
  output_per_million numeric(20,8),
  per_message numeric(20,8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_rates_values_nonnegative CHECK (
    (input_per_million IS NULL OR input_per_million >= 0)
    AND (cached_input_per_million IS NULL OR cached_input_per_million >= 0)
    AND (output_per_million IS NULL OR output_per_million >= 0)
    AND (per_message IS NULL OR per_message >= 0)
  ),
  CONSTRAINT cost_rates_type CHECK (
    (source='ai' AND currency='USD' AND input_per_million IS NOT NULL
      AND output_per_million IS NOT NULL AND per_message IS NULL)
    OR
    (source='meta' AND currency='BRL' AND per_message IS NOT NULL
      AND input_per_million IS NULL AND output_per_million IS NULL
      AND cached_input_per_million IS NULL)
  ),
  UNIQUE(account_id,source,sku,effective_from)
);
CREATE INDEX IF NOT EXISTS idx_cost_rates_lookup ON wacrm.cost_rates(account_id,source,sku,effective_from DESC);

CREATE TABLE IF NOT EXISTS wacrm.ai_token_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  feature text NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,provider,request_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_account_month ON wacrm.ai_token_usage(account_id,occurred_at);

CREATE TABLE IF NOT EXISTS wacrm.meta_deliveries_cost (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  channel_id uuid,
  occurred_at timestamptz NOT NULL,
  country_code text NOT NULL DEFAULT 'UNKNOWN',
  category text,
  pricing_billable boolean,
  pricing_type text,
  metadata_origin text NOT NULL CHECK (metadata_origin IN ('webhook','historical_inferred')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_delivery_account_month ON wacrm.meta_deliveries_cost(account_id,occurred_at);

-- Browser users cannot read billing ledgers directly or write tariffs.
-- The server API verifies admin+ and filters account_id before calling the
-- RPC below with service_role. No data of other tenants crosses the API.
ALTER TABLE wacrm.cost_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.ai_token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.meta_deliveries_cost ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.cost_rates, wacrm.ai_token_usage, wacrm.meta_deliveries_cost FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON wacrm.cost_rates TO service_role;
GRANT SELECT, INSERT ON wacrm.ai_token_usage TO service_role;
GRANT SELECT, INSERT, UPDATE ON wacrm.meta_deliveries_cost TO service_role;

-- Retrospective best-effort Meta delivery coverage from CRM records.
-- Timestamp is message-created time, not Meta invoice time; category may
-- be missing when template catalog has been renamed or reused. Rows with
-- unknown category/country remain UNPRICED rather than silently treated free.
INSERT INTO wacrm.meta_deliveries_cost
  (account_id,message_id,channel_id,occurred_at,country_code,category,metadata_origin)
SELECT c.account_id, m.message_id, c.config_id, m.created_at,
  CASE WHEN regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g') ~ '^55[0-9]{10,11}$' THEN 'BR' ELSE 'UNKNOWN' END,
  (
    SELECT lower(t.category) FROM wacrm.message_templates t
    WHERE t.account_id=c.account_id
      AND lower(t.name)=lower(m.template_name)
      AND lower(t.category) IN ('marketing','utility','authentication')
    ORDER BY t.created_at DESC
    LIMIT 1
  ),
  'historical_inferred'
FROM wacrm.messages m
JOIN wacrm.conversations c ON c.id=m.conversation_id
JOIN wacrm.whatsapp_config w ON w.id=c.config_id AND w.account_id=c.account_id AND w.provider='meta'
LEFT JOIN wacrm.contacts ct ON ct.id=c.contact_id AND ct.account_id=c.account_id
WHERE m.sender_type<>'customer'
  AND m.status IN ('delivered','read')
  AND m.message_id IS NOT NULL AND m.message_id<>''
ON CONFLICT (account_id,message_id) DO NOTHING;

-- Keep Meta billing status metadata DURABLY in the same transaction that
-- inserts webhook_status_inbox. The existing dispatcher inbox flow remains
-- unchanged; this adds no second network round-trip to the critical webhook.
CREATE OR REPLACE FUNCTION wacrm.ingest_status_events(p_events jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_inserted integer;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN RETURN 0; END IF;

  WITH ins AS (
    INSERT INTO wacrm.webhook_status_inbox(account_id,channel_id,message_id,status,error_text,event_ts)
    SELECT e.account_id,e.channel_id,e.message_id,e.status,e.error_text,
           CASE WHEN e.ts>0 THEN to_timestamp(e.ts) ELSE NULL END
    FROM jsonb_to_recordset(p_events) AS e(
      account_id uuid,channel_id uuid,message_id text,status text,error_text text,ts double precision,
      pricing_category text,pricing_type text,pricing_billable boolean,country_code text
    )
    WHERE e.message_id IS NOT NULL AND e.message_id<>''
      AND e.status IN ('delivered','read','failed')
    ON CONFLICT (message_id,status) DO NOTHING
    RETURNING 1
  ) SELECT count(*)::integer INTO v_inserted FROM ins;

  INSERT INTO wacrm.meta_deliveries_cost
    (account_id,message_id,channel_id,occurred_at,country_code,category,pricing_billable,pricing_type,metadata_origin)
  SELECT e.account_id,e.message_id,e.channel_id,
         CASE WHEN e.ts>0 THEN to_timestamp(e.ts) ELSE now() END,
         CASE WHEN e.country_code='BR' THEN 'BR' ELSE 'UNKNOWN' END,
         CASE WHEN lower(e.pricing_category) IN ('marketing','utility','authentication','service')
              THEN lower(e.pricing_category) ELSE NULL END,
         e.pricing_billable,left(e.pricing_type,100),'webhook'
  FROM jsonb_to_recordset(p_events) AS e(
    account_id uuid,channel_id uuid,message_id text,status text,error_text text,ts double precision,
    pricing_category text,pricing_type text,pricing_billable boolean,country_code text
  )
  WHERE e.message_id IS NOT NULL AND e.message_id<>''
    AND e.account_id IS NOT NULL AND e.status IN ('delivered','read')
  ON CONFLICT (account_id,message_id) DO UPDATE SET
    channel_id=coalesce(EXCLUDED.channel_id,wacrm.meta_deliveries_cost.channel_id),
    occurred_at=CASE WHEN wacrm.meta_deliveries_cost.metadata_origin='historical_inferred'
                     THEN EXCLUDED.occurred_at ELSE wacrm.meta_deliveries_cost.occurred_at END,
    country_code=CASE WHEN EXCLUDED.country_code='BR' THEN 'BR' ELSE wacrm.meta_deliveries_cost.country_code END,
    category=coalesce(EXCLUDED.category,wacrm.meta_deliveries_cost.category),
    pricing_billable=coalesce(EXCLUDED.pricing_billable,wacrm.meta_deliveries_cost.pricing_billable),
    pricing_type=coalesce(EXCLUDED.pricing_type,wacrm.meta_deliveries_cost.pricing_type),
    metadata_origin='webhook';

  RETURN coalesce(v_inserted,0);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.ingest_status_events(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.ingest_status_events(jsonb) TO service_role;

-- One aggregated query per month, no client-side pagination or cost
-- computed from message count alone. Rates selected by event date; null
-- rate -> unpriced count, never an invented zero.
CREATE OR REPLACE FUNCTION wacrm.get_monthly_cost_report(p_account_id uuid,p_month date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = ''
AS $$
WITH boundaries AS (
  SELECT date_trunc('month',p_month::timestamp) AT TIME ZONE 'America/Sao_Paulo' AS starts,
         (date_trunc('month',p_month::timestamp)+interval '1 month') AT TIME ZONE 'America/Sao_Paulo' AS ends
), ai_rows AS (
  SELECT e.provider||':'||e.model AS sku, e.feature, e.input_tokens,e.output_tokens,e.cached_input_tokens,
    CASE WHEN r.input_per_million IS NULL OR r.output_per_million IS NULL
                 OR (e.cached_input_tokens>0 AND r.cached_input_per_million IS NULL)
         THEN NULL
         ELSE
           ((e.input_tokens-e.cached_input_tokens)::numeric*r.input_per_million
            +e.cached_input_tokens::numeric*coalesce(r.cached_input_per_million,0)
            +e.output_tokens::numeric*r.output_per_million)/1000000
    END AS amount
  FROM wacrm.ai_token_usage e CROSS JOIN boundaries b
  LEFT JOIN LATERAL (
    SELECT input_per_million,cached_input_per_million,output_per_million
    FROM wacrm.cost_rates r
    WHERE r.account_id=e.account_id AND r.source='ai'
      AND r.sku=e.provider||':'||e.model
      AND r.effective_from <= (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
    ORDER BY r.effective_from DESC LIMIT 1
  ) r ON true
  WHERE e.account_id=p_account_id AND e.occurred_at>=b.starts AND e.occurred_at<b.ends
), ai_grouped AS (
 SELECT sku,count(*)::bigint requests,sum(input_tokens)::bigint input_tokens,
   sum(output_tokens)::bigint output_tokens,
   sum(cached_input_tokens)::bigint cached_input_tokens,
   sum(coalesce(amount,0))::numeric(20,8) priced_usd,
   count(*) FILTER(WHERE amount IS NULL)::bigint unpriced
 FROM ai_rows GROUP BY sku
), meta_rows AS (
 SELECT concat_ws(':',e.country_code,coalesce(e.category,'uncategorized')) AS sku,
   e.metadata_origin,
   CASE WHEN e.pricing_billable=false THEN 0::numeric
        WHEN e.country_code<>'BR' OR e.category IS NULL THEN NULL::numeric
        ELSE r.per_message END AS amount
 FROM wacrm.meta_deliveries_cost e CROSS JOIN boundaries b
 LEFT JOIN LATERAL (
   SELECT per_message FROM wacrm.cost_rates r
   WHERE r.account_id=e.account_id AND r.source='meta'
     AND r.sku=concat_ws(':',e.country_code,e.category)
     AND r.effective_from <= (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
   ORDER BY r.effective_from DESC LIMIT 1
 ) r ON true
 WHERE e.account_id=p_account_id AND e.occurred_at>=b.starts AND e.occurred_at<b.ends
), meta_grouped AS (
 SELECT sku,count(*)::bigint delivered,
   count(*) FILTER(WHERE metadata_origin='historical_inferred')::bigint inferred,
   sum(coalesce(amount,0))::numeric(20,8) priced_brl,
   count(*) FILTER(WHERE amount IS NULL)::bigint unpriced
 FROM meta_rows GROUP BY sku
)
SELECT pg_catalog.jsonb_build_object(
 'ai',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.sku) FROM ai_grouped a),'[]'::jsonb),
 'meta',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.sku) FROM meta_grouped m),'[]'::jsonb)
);
$$;
REVOKE ALL ON FUNCTION wacrm.get_monthly_cost_report(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.get_monthly_cost_report(uuid,date) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations(version) VALUES('377_dashboard_costs') ON CONFLICT DO NOTHING;
  END IF;
END $$;
COMMIT;
NOTIFY pgrst,'reload schema';

-- POST-CHECK:
-- SELECT to_regclass('wacrm.ai_token_usage'),to_regclass('wacrm.meta_deliveries_cost'),to_regclass('wacrm.cost_rates');
-- SELECT has_function_privilege('anon','wacrm.get_monthly_cost_report(uuid,date)','EXECUTE'); -- false
-- SELECT wacrm.get_monthly_cost_report('ACCOUNT_UUID','2026-10-01'::date); -- admin SQL only
