-- ============================================================
-- 380_ai_costs_by_feature.sql   (custo estimado de IA também POR FUNCIONALIDADE)
--
-- O QUE FAZ: substitui wacrm.get_monthly_ai_cost_report(uuid,date) (378) por uma versão com o MESMO retorno jsonb e a MESMA assinatura, que além de
--   'ai' (por provedor:modelo, igual à 378) devolve:
--     'by_feature'        por funcionalidade (ai_token_usage.feature: responder, disparador, intelligence, acordo, sentiment, tabulacao, rewrite, copilot…),
--                         ordenado por valor desc e depois pelo nome;
--     'by_feature_model'  funcionalidade × provedor:modelo, ordenado por funcionalidade e valor desc.
--   Mesma regra de tarifa da 378 (vigência do dia da chamada, fuso America/Sao_Paulo; sem tarifa = "unpriced", nunca zero), então a soma de by_feature
--   == a soma de ai. ESTIMATIVA, não fatura. Sem tabela nova, sem dado novo: só lê wacrm.ai_token_usage e wacrm.cost_rates.
--   Permissões e RLS não mudam (CREATE OR REPLACE preserva os GRANTs; reafirmados abaixo): só service_role chama, pela API com requirePermission.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regprocedure('wacrm.get_monthly_ai_cost_report(uuid,date)');                                 -- NÃO nulo (378)
--   SELECT to_regclass('wacrm.ai_token_usage'), to_regclass('wacrm.cost_rates');                            -- não nulos (378)
--   SELECT pg_get_function_result('wacrm.get_monthly_ai_cost_report(uuid,date)'::regprocedure);             -- jsonb
-- VERIFICAÇÃO (depois):
--   SELECT jsonb_object_keys(wacrm.get_monthly_ai_cost_report('<conta>'::uuid, '2026-10-01'::date));        -- ai, by_feature, by_feature_model
--   SELECT has_function_privilege('anon', 'wacrm.get_monthly_ai_cost_report(uuid,date)', 'EXECUTE');        -- false
-- ORDEM: depois da 378. Antes ou depois do deploy: sem a 380 a API devolve o relatório sem by_feature (a tela esconde o seletor). Idempotente.
-- ROLLBACK (volta à função da 378):
--   BEGIN;
--   CREATE OR REPLACE FUNCTION wacrm.get_monthly_ai_cost_report(p_account_id uuid, p_month date) RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
--   WITH boundaries AS (
--     SELECT date_trunc('month', p_month::timestamp) AT TIME ZONE 'America/Sao_Paulo' AS starts,
--            (date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'America/Sao_Paulo' AS ends
--   ), ai_rows AS (
--     SELECT e.provider || ':' || e.model AS sku, e.input_tokens, e.output_tokens, e.cached_input_tokens,
--       CASE WHEN r.input_per_million IS NULL OR r.output_per_million IS NULL
--                 OR (e.cached_input_tokens > 0 AND r.cached_input_per_million IS NULL)
--            THEN NULL
--            ELSE ((e.input_tokens - e.cached_input_tokens)::numeric * r.input_per_million
--                  + e.cached_input_tokens::numeric * coalesce(r.cached_input_per_million, 0)
--                  + e.output_tokens::numeric * r.output_per_million) / 1000000
--       END AS amount
--     FROM wacrm.ai_token_usage e CROSS JOIN boundaries b
--     LEFT JOIN LATERAL (
--       SELECT input_per_million, cached_input_per_million, output_per_million
--       FROM wacrm.cost_rates r
--       WHERE r.account_id = e.account_id AND r.source = 'ai'
--         AND r.sku = e.provider || ':' || e.model
--         AND r.effective_from <= (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
--       ORDER BY r.effective_from DESC LIMIT 1
--     ) r ON true
--     WHERE e.account_id = p_account_id AND e.occurred_at >= b.starts AND e.occurred_at < b.ends
--   ), ai_grouped AS (
--     SELECT sku, count(*)::bigint AS requests, sum(input_tokens)::bigint AS input_tokens,
--            sum(output_tokens)::bigint AS output_tokens, sum(cached_input_tokens)::bigint AS cached_input_tokens,
--            sum(coalesce(amount, 0))::numeric(20,8) AS priced_usd,
--            count(*) FILTER (WHERE amount IS NULL)::bigint AS unpriced
--     FROM ai_rows GROUP BY sku
--   )
--   SELECT pg_catalog.jsonb_build_object(
--     'ai', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.sku) FROM ai_grouped a), '[]'::jsonb)
--   );
--   $$;
--   DELETE FROM wacrm.schema_migrations WHERE version = '380_ai_costs_by_feature';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.get_monthly_ai_cost_report(uuid,date)') IS NULL THEN
    RAISE EXCEPTION '380: falta wacrm.get_monthly_ai_cost_report(uuid,date) (migration 378)';
  END IF;
  IF to_regclass('wacrm.ai_token_usage') IS NULL OR to_regclass('wacrm.cost_rates') IS NULL THEN
    RAISE EXCEPTION '380: faltam wacrm.ai_token_usage / wacrm.cost_rates (migration 378)';
  END IF;
END $$;

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
  SELECT e.provider || ':' || e.model AS sku, e.feature, e.input_tokens, e.output_tokens, e.cached_input_tokens,
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
), feature_grouped AS (
  SELECT feature, count(*)::bigint AS requests, sum(input_tokens)::bigint AS input_tokens,
         sum(output_tokens)::bigint AS output_tokens, sum(cached_input_tokens)::bigint AS cached_input_tokens,
         sum(coalesce(amount, 0))::numeric(20,8) AS priced_usd,
         count(*) FILTER (WHERE amount IS NULL)::bigint AS unpriced
  FROM ai_rows GROUP BY feature
), feature_model_grouped AS (
  SELECT feature, sku, count(*)::bigint AS requests, sum(input_tokens)::bigint AS input_tokens,
         sum(output_tokens)::bigint AS output_tokens, sum(cached_input_tokens)::bigint AS cached_input_tokens,
         sum(coalesce(amount, 0))::numeric(20,8) AS priced_usd,
         count(*) FILTER (WHERE amount IS NULL)::bigint AS unpriced
  FROM ai_rows GROUP BY feature, sku
)
SELECT pg_catalog.jsonb_build_object(
  'ai', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.sku) FROM ai_grouped a), '[]'::jsonb),
  'by_feature', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(f) ORDER BY f.priced_usd DESC, f.feature) FROM feature_grouped f), '[]'::jsonb),
  'by_feature_model', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.feature, m.priced_usd DESC, m.sku) FROM feature_model_grouped m), '[]'::jsonb)
);
$$;
REVOKE ALL ON FUNCTION wacrm.get_monthly_ai_cost_report(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.get_monthly_ai_cost_report(uuid, date) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('380_ai_costs_by_feature') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
