-- ============================================================
-- 378_ai_costs.sql   (custo estimado de IA — METADE DE IA da 377 da V1; o custo Meta continua na 195)
--
-- ORIGEM: a 377_dashboard_costs da V1 (branch feat/v1-dashboard-monthly-ai-meta-costs-20261015). Aqui entra SÓ a IA: tarifas (cost_rates), uso de
--   tokens (ai_token_usage) e o relatório mensal de IA. NÃO traz meta_deliveries_cost nem o backfill 'historical_inferred' e NÃO reescreve
--   ingest_status_events: o custo Meta da V2 vem de wacrm.dispatch_message_pricing (195, dispatch_cost_summary). Nunca aplicar a 377 original por cima.
--
-- O QUE FAZ:
--   1. wacrm.cost_rates      tarifa por conta × fonte × item × vigência (IA em USD por milhão de tokens). Mesma definição da 377 (a CHECK aceita 'meta'
--                            só para ficar idêntica à da V1; a V2 só usa 'ai').
--   2. wacrm.ai_token_usage  UMA linha por chamada ao provedor: conta, request_id, provedor, modelo, funcionalidade e CONTAGENS de tokens. Nunca guarda
--                            prompt, mensagem, resposta, nome ou telefone (LGPD). Único por (conta, provedor, request_id): repetir a gravação não duplica.
--   3. wacrm.get_monthly_ai_cost_report(conta, mês)   agregado do mês (fuso America/Sao_Paulo) por provedor:modelo; tarifa pela vigência do dia da chamada;
--                            sem tarifa = "sem preço" (contagem), nunca zero inventado. ESTIMATIVA, não fatura.
--   Segurança: RLS ligada SEM policy e sem GRANT para anon/authenticated (o navegador não lê nem grava); só service_role, pela API (requirePermission +
--   escopo por conta). apply_mfa_policy (310) aplicada se existir.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.accounts');                                                                   -- não nulo
--   SELECT to_regclass('wacrm.cost_rates'), to_regclass('wacrm.ai_token_usage');                            -- NULL na 1ª vez; se a V1 já aplicou a 377, não nulos (a 378 reaproveita: IF NOT EXISTS)
--   SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'get_monthly_ai_cost_report';  -- 0 linhas na 1ª vez
--   SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy';           -- existe se a 310 foi aplicada (opcional)
-- VERIFICAÇÃO (depois):
--   SELECT has_table_privilege('authenticated', 'wacrm.ai_token_usage', 'SELECT');                          -- false
--   SELECT has_function_privilege('anon', 'wacrm.get_monthly_ai_cost_report(uuid,date)', 'EXECUTE');        -- false
--   SELECT wacrm.get_monthly_ai_cost_report('<conta>'::uuid, '2026-10-01'::date);                           -- só no SQL Editor (admin)
-- ORDEM: antes ou depois do deploy (sem a migration a API responde 503 e a gravação de uso vira no-op silencioso). Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.get_monthly_ai_cost_report(uuid, date);
--   DROP TABLE IF EXISTS wacrm.ai_token_usage;   -- ⚠️ apaga o histórico de uso; se a 377 da V1 também está aplicada, NÃO rode (as tabelas são dela)
--   DROP TABLE IF EXISTS wacrm.cost_rates;       -- idem
--   DELETE FROM wacrm.schema_migrations WHERE version = '378_ai_costs';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '378: falta wacrm.accounts — confira o schema vivo';
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
  UNIQUE (account_id, source, sku, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_cost_rates_lookup ON wacrm.cost_rates (account_id, source, sku, effective_from DESC);

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
  UNIQUE (account_id, provider, request_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_account_month ON wacrm.ai_token_usage (account_id, occurred_at);

-- O navegador não lê nem grava: RLS ligada sem policy + REVOKE. Só o servidor (service_role), depois de requirePermission e do filtro por conta.
ALTER TABLE wacrm.cost_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.ai_token_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.cost_rates, wacrm.ai_token_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON wacrm.cost_rates TO service_role;
GRANT SELECT, INSERT ON wacrm.ai_token_usage TO service_role;

-- Relatório mensal de IA: uma consulta agregada. Tarifa escolhida pela vigência do dia da chamada; sem tarifa => "unpriced", nunca zero.
CREATE OR REPLACE FUNCTION wacrm.get_monthly_ai_cost_report(p_account_id uuid, p_month date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
WITH boundaries AS (
  SELECT date_trunc('month', p_month::timestamp) AT TIME ZONE 'America/Sao_Paulo' AS starts,
         (date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'America/Sao_Paulo' AS ends
), ai_rows AS (
  SELECT e.provider || ':' || e.model AS sku, e.input_tokens, e.output_tokens, e.cached_input_tokens,
    CASE WHEN r.input_per_million IS NULL OR r.output_per_million IS NULL
              OR (e.cached_input_tokens > 0 AND r.cached_input_per_million IS NULL)
         THEN NULL
         ELSE ((e.input_tokens - e.cached_input_tokens)::numeric * r.input_per_million
               + e.cached_input_tokens::numeric * coalesce(r.cached_input_per_million, 0)
               + e.output_tokens::numeric * r.output_per_million) / 1000000
    END AS amount
  FROM wacrm.ai_token_usage e CROSS JOIN boundaries b
  LEFT JOIN LATERAL (
    SELECT input_per_million, cached_input_per_million, output_per_million
    FROM wacrm.cost_rates r
    WHERE r.account_id = e.account_id AND r.source = 'ai'
      AND r.sku = e.provider || ':' || e.model
      AND r.effective_from <= (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
    ORDER BY r.effective_from DESC LIMIT 1
  ) r ON true
  WHERE e.account_id = p_account_id AND e.occurred_at >= b.starts AND e.occurred_at < b.ends
), ai_grouped AS (
  SELECT sku, count(*)::bigint AS requests, sum(input_tokens)::bigint AS input_tokens,
         sum(output_tokens)::bigint AS output_tokens, sum(cached_input_tokens)::bigint AS cached_input_tokens,
         sum(coalesce(amount, 0))::numeric(20,8) AS priced_usd,
         count(*) FILTER (WHERE amount IS NULL)::bigint AS unpriced
  FROM ai_rows GROUP BY sku
)
SELECT pg_catalog.jsonb_build_object(
  'ai', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.sku) FROM ai_grouped a), '[]'::jsonb)
);
$$;
REVOKE ALL ON FUNCTION wacrm.get_monthly_ai_cost_report(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.get_monthly_ai_cost_report(uuid, date) TO service_role;

-- 2FA (migration 310): se já aplicada, cobre as tabelas novas aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy') THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.cost_rates'::regclass);
    PERFORM wacrm.apply_mfa_policy('wacrm.ai_token_usage'::regclass);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('378_ai_costs') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
