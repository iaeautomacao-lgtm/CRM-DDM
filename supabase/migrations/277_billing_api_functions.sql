-- ============================================================
-- 277_billing_api_functions.sql   (PRD 17, PR 17.5 — funções da API /api/billing/*: trocar as etapas de uma régua e as métricas)
--
--   billing_replace_steps(account, ruler, steps jsonb)   "PUT /rulers/:id/steps": troca a lista de etapas de uma régua em UMA transação.
--        - elemento com "id" = atualiza a etapa (o id e o histórico de envios ficam); sem "id" = cria; etapa existente que NÃO veio na lista
--          é removida SE nunca teve envio; com histórico de envio a troca é recusada (step_has_history) — o front manda a etapa com active=false.
--        - a posição vem da ordem da lista. Nada de apagar-e-recriar: ON DELETE CASCADE de billing_step_sends perderia o histórico.
--        - régua de outra conta ou inexistente ⇒ ruler_not_found. A validação de negócio (template aprovado, {{n}} completos) é da rota.
--   billing_ruler_metrics(account, ruler)                envios por (etapa, status) e inscrições por (status, motivo de parada), agregados no banco
--        (com 200 mil inscrições a rota não traz linhas para somar no Node). Sem CPF/telefone/texto: só contagens.
-- Funções SECURITY DEFINER, só service_role (a rota checa billing.view / billing.manage e filtra pela conta da sessão).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.billing_ruler_steps'), to_regclass('wacrm.billing_step_sends'), to_regclass('wacrm.billing_enrollments');   -- não nulos (270–273)
--             SELECT to_regprocedure('wacrm.billing_replace_steps(uuid,uuid,jsonb)');   -- NULL na 1ª vez
--             SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='billing_ruler_steps' AND column_name='variable_map';   -- 1 linha (279)
-- ORDEM: depois da 279 (usa variable_map). Antes ou depois do deploy (sem ela, PUT steps e métricas respondem 503). Idempotente.
-- ROLLBACK:   BEGIN; DROP FUNCTION IF EXISTS wacrm.billing_replace_steps(uuid, uuid, jsonb), wacrm.billing_ruler_metrics(uuid, uuid);
--             DELETE FROM wacrm.schema_migrations WHERE version = '277_billing_api_functions'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.billing_ruler_steps') IS NULL OR to_regclass('wacrm.billing_step_sends') IS NULL OR to_regclass('wacrm.billing_enrollments') IS NULL THEN
    RAISE EXCEPTION '277: faltam as tabelas da régua (migrations 270–273)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'billing_ruler_steps' AND column_name = 'variable_map') THEN
    RAISE EXCEPTION '277: falta billing_ruler_steps.variable_map (migration 279)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.billing_replace_steps(p_account uuid, p_ruler uuid, p_steps jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_ids uuid[];
  v_n integer;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'billing_replace_steps: steps deve ser um array';
  END IF;
  PERFORM 1 FROM wacrm.billing_rulers WHERE id = p_ruler AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ruler_not_found'; END IF;

  -- ids informados precisam ser etapas DESTA régua
  SELECT array_agg((e.value ->> 'id')::uuid) INTO v_ids FROM jsonb_array_elements(p_steps) e WHERE e.value ? 'id' AND e.value ->> 'id' IS NOT NULL;
  IF v_ids IS NOT NULL AND (SELECT count(*) FROM wacrm.billing_ruler_steps WHERE ruler_id = p_ruler AND id = ANY (v_ids)) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'step_not_found';
  END IF;

  -- etapa existente que não veio na lista: só sai se nunca teve envio
  IF EXISTS (
    SELECT 1 FROM wacrm.billing_ruler_steps s
     WHERE s.ruler_id = p_ruler AND NOT (s.id = ANY (coalesce(v_ids, '{}'::uuid[])))
       AND EXISTS (SELECT 1 FROM wacrm.billing_step_sends x WHERE x.step_id = s.id)
  ) THEN
    RAISE EXCEPTION 'step_has_history';
  END IF;
  DELETE FROM wacrm.billing_ruler_steps WHERE ruler_id = p_ruler AND NOT (id = ANY (coalesce(v_ids, '{}'::uuid[])));

  -- as posições existentes saem do caminho (índice único (régua, posição)) antes de gravar a ordem nova
  UPDATE wacrm.billing_ruler_steps SET position = position + 100000 WHERE ruler_id = p_ruler;

  WITH incoming AS (
    SELECT (e.ord - 1)::integer AS pos, e.value AS v
      FROM jsonb_array_elements(p_steps) WITH ORDINALITY AS e(value, ord)
  ), upd AS (
    UPDATE wacrm.billing_ruler_steps s
       SET position = i.pos,
           kind = i.v ->> 'kind',
           offset_days = (i.v ->> 'offset_days')::integer,
           status_trigger = i.v ->> 'status_trigger',
           template_id = (i.v ->> 'template_id')::uuid,
           message_text = i.v ->> 'message_text',
           variable_map = coalesce(i.v -> 'variable_map', '[]'::jsonb),
           conditions = coalesce(i.v -> 'conditions', '{}'::jsonb),
           active = coalesce((i.v ->> 'active')::boolean, true),
           updated_at = now()
      FROM incoming i
     WHERE s.ruler_id = p_ruler AND i.v ? 'id' AND s.id = (i.v ->> 'id')::uuid
    RETURNING s.id
  ), ins AS (
    INSERT INTO wacrm.billing_ruler_steps (account_id, ruler_id, position, kind, offset_days, status_trigger, template_id, message_text, variable_map, conditions, active)
    SELECT p_account, p_ruler, i.pos, i.v ->> 'kind', (i.v ->> 'offset_days')::integer, i.v ->> 'status_trigger', (i.v ->> 'template_id')::uuid,
           i.v ->> 'message_text', coalesce(i.v -> 'variable_map', '[]'::jsonb), coalesce(i.v -> 'conditions', '{}'::jsonb), coalesce((i.v ->> 'active')::boolean, true)
      FROM incoming i WHERE NOT (i.v ? 'id')
    RETURNING id
  )
  SELECT (SELECT count(*) FROM upd) + (SELECT count(*) FROM ins) INTO v_n;

  UPDATE wacrm.billing_rulers SET updated_at = now() WHERE id = p_ruler;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.billing_ruler_metrics(p_account uuid, p_ruler uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = wacrm, public
AS $$
  SELECT jsonb_build_object(
    'steps', coalesce((
      SELECT jsonb_agg(jsonb_build_object('step_id', t.step_id, 'status', t.status, 'total', t.total))
        FROM (SELECT x.step_id, x.status, count(*) AS total
                FROM wacrm.billing_step_sends x
                JOIN wacrm.billing_ruler_steps s ON s.id = x.step_id
               WHERE s.ruler_id = p_ruler AND s.account_id = p_account
               GROUP BY x.step_id, x.status) t), '[]'::jsonb),
    'enrollments', coalesce((
      SELECT jsonb_agg(jsonb_build_object('status', t.status, 'stop_reason', t.stop_reason, 'total', t.total))
        FROM (SELECT en.status, en.stop_reason, count(*) AS total
                FROM wacrm.billing_enrollments en
               WHERE en.ruler_id = p_ruler AND en.account_id = p_account
               GROUP BY en.status, en.stop_reason) t), '[]'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION wacrm.billing_replace_steps(uuid, uuid, jsonb), wacrm.billing_ruler_metrics(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.billing_replace_steps(uuid, uuid, jsonb), wacrm.billing_ruler_metrics(uuid, uuid) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('277_billing_api_functions') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
