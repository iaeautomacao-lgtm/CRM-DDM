-- ============================================================
-- 279_billing_enqueue.sql   (PRD 17, PR 17.4 — régua de cobrança: entrega ao disparador, origem e teto com campanha manual)
--
-- Decisão do dono (09/10): coluna `origem` ('manual' | 'regua') em campaigns E na fila (mais simples de consultar no Desempenho); o teto diário
-- por devedor conta a campanha MANUAL junto.
--   1. wacrm.campaigns.origem / wacrm.disp_message_queue.origem  text NOT NULL DEFAULT 'manual'. A régua cria uma campanha-sistema por
--      (régua, canal, dia) com origem='regua' e enfileira na fila EXISTENTE (mesma janela, ritmo, qualidade, blacklist, pausa e recibos).
--      ADD COLUMN com DEFAULT constante não reescreve a tabela; o CHECK entra NOT VALID (vale para linhas novas; o VALIDATE da fila grande
--      fica a seu critério, fora do horário: ALTER TABLE wacrm.disp_message_queue VALIDATE CONSTRAINT disp_message_queue_origem_check;).
--   2. wacrm.billing_ruler_steps.variable_map jsonb — de onde vem cada {{n}} do template/texto da etapa (configuração DA OPERAÇÃO, por etapa):
--      [{"type":"contact_field","field":"name"}, {"type":"debt_field","field":"due_date"|"amount"|"external_ref"}, {"type":"static","value":"…"}].
--   3. billing_claim_due_steps (substitui a da 274): o teto diário passa a somar os envios MANUAIS do contato que já saíram hoje
--      (índice contact_id, sent_at da 126; só o que de fato saiu — o que a régua enfileirou já está contado pelo billing_step_sends).
--   4. wacrm.billing_reconcile_sends(conta, limite): traz o resultado da fila para billing_step_sends (entregue→sent, erro permanente→error,
--      cancelado→cancelled). Roda a cada tick do motor; erro com retry automático NÃO conta como erro até esgotar.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.campaigns'), to_regclass('wacrm.disp_message_queue'), to_regclass('wacrm.billing_ruler_steps');   -- não nulos
--             SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name IN ('campaigns','disp_message_queue') AND column_name='origem';  -- 0 linhas na 1ª vez
--             SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='disp_message_queue' AND column_name IN ('sent_at','erro','erro_codigo','erro_permanente'); -- 4 linhas
-- ORDEM: depois da 274. Idempotente.
-- ROLLBACK:   BEGIN; ALTER TABLE wacrm.campaigns DROP COLUMN IF EXISTS origem; ALTER TABLE wacrm.disp_message_queue DROP COLUMN IF EXISTS origem;
--             ALTER TABLE wacrm.billing_ruler_steps DROP COLUMN IF EXISTS variable_map; DROP FUNCTION IF EXISTS wacrm.billing_reconcile_sends(uuid, integer);
--             -- e recrie billing_claim_due_steps com o corpo da 274;
--             DELETE FROM wacrm.schema_migrations WHERE version = '279_billing_enqueue'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL OR to_regclass('wacrm.disp_message_queue') IS NULL OR to_regclass('wacrm.billing_ruler_steps') IS NULL
     OR to_regprocedure('wacrm.billing_claim_due_steps(uuid,integer,timestamptz)') IS NULL THEN
    RAISE EXCEPTION '279: faltam campaigns/disp_message_queue ou as migrations 270–274 da régua';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'disp_message_queue'
        AND column_name IN ('sent_at', 'erro', 'erro_codigo', 'erro_permanente')) <> 4 THEN
    RAISE EXCEPTION '279: disp_message_queue sem sent_at/erro/erro_codigo/erro_permanente — confira o schema vivo';
  END IF;
END $$;

ALTER TABLE wacrm.campaigns ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'manual';
ALTER TABLE wacrm.disp_message_queue ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_origem_check' AND conrelid = 'wacrm.campaigns'::regclass) THEN
    ALTER TABLE wacrm.campaigns ADD CONSTRAINT campaigns_origem_check CHECK (origem IN ('manual', 'regua')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'disp_message_queue_origem_check' AND conrelid = 'wacrm.disp_message_queue'::regclass) THEN
    ALTER TABLE wacrm.disp_message_queue ADD CONSTRAINT disp_message_queue_origem_check CHECK (origem IN ('manual', 'regua')) NOT VALID;
  END IF;
END $$;

ALTER TABLE wacrm.billing_ruler_steps
  ADD COLUMN IF NOT EXISTS variable_map jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_steps_variable_map_check' AND conrelid = 'wacrm.billing_ruler_steps'::regclass) THEN
    ALTER TABLE wacrm.billing_ruler_steps ADD CONSTRAINT billing_steps_variable_map_check
      CHECK (jsonb_typeof(variable_map) = 'array' AND jsonb_array_length(variable_map) <= 10);
  END IF;
END $$;


CREATE OR REPLACE FUNCTION wacrm.billing_claim_due_steps(p_account uuid, p_limit integer DEFAULT 200, p_now timestamptz DEFAULT now())
RETURNS TABLE (
  send_id uuid, enrollment_id uuid, step_id uuid, account_id uuid, ruler_id uuid, debt_id uuid, contact_id uuid, channel_id uuid,
  send_key text, due_at timestamptz, template_id uuid, message_text text, due_date date, amount_cents bigint, external_ref text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
#variable_conflict use_column
DECLARE
  e record;
  st record;
  v_local timestamp := p_now AT TIME ZONE 'America/Sao_Paulo';
  v_today date := (p_now AT TIME ZONE 'America/Sao_Paulo')::date;
  v_day_start timestamptz := ((p_now AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_day_end timestamptz := (((p_now AT TIME ZONE 'America/Sao_Paulo')::date + 1)::timestamp) AT TIME ZONE 'America/Sao_Paulo';
  v_count integer;
  v_id uuid;
  v_manual_counts boolean := to_regclass('wacrm.disp_message_queue') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'disp_message_queue' AND column_name = 'origem');
BEGIN
  FOR e IN
    SELECT en.id AS e_id, en.ruler_id AS e_ruler, en.debt_id AS e_debt, en.created_at AS enrolled_at, ru.channel_id AS e_channel,
           ru.window_start, ru.daily_cap_per_debtor AS cap, ru.tolerance_days, d.contact_id AS e_contact, d.due_date AS e_due,
           d.amount_cents AS e_amount, d.external_ref AS e_ref
      FROM wacrm.billing_enrollments en
      JOIN wacrm.billing_rulers ru ON ru.id = en.ruler_id AND ru.active AND NOT ru.dry_run
      JOIN wacrm.billing_debts d ON d.id = en.debt_id AND d.status = 'open'
     WHERE en.account_id = p_account AND en.status = 'active' AND en.next_step_at <= p_now
       AND v_local::time BETWEEN ru.window_start AND ru.window_end
       AND extract(dow FROM v_local)::smallint = ANY (ru.weekdays)
     ORDER BY ru.priority, en.next_step_at
     LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
       FOR UPDATE OF en SKIP LOCKED
  LOOP
    LOOP
      SELECT s.id AS s_id, s.template_id AS s_template, s.message_text AS s_text,
             wacrm.billing_step_due_at(e.e_due, s.offset_days, e.window_start) AS s_due
        INTO st
        FROM wacrm.billing_ruler_steps s
       WHERE s.ruler_id = e.e_ruler AND s.active AND s.kind = 'offset'
         AND NOT EXISTS (SELECT 1 FROM wacrm.billing_step_sends x WHERE x.enrollment_id = e.e_id AND x.step_id = s.id)
         AND wacrm.billing_step_due_at(e.e_due, s.offset_days, e.window_start) >= e.enrolled_at - make_interval(days => e.tolerance_days)
       ORDER BY s.offset_days
       LIMIT 1;

      IF NOT FOUND THEN  -- todas as etapas cumpridas (ou fora do alcance)
        UPDATE wacrm.billing_enrollments SET status = 'completed', next_step_at = NULL, updated_at = now() WHERE id = e.e_id;
        EXIT;
      END IF;
      IF st.s_due > p_now THEN  -- a próxima ainda não venceu
        UPDATE wacrm.billing_enrollments SET next_step_at = st.s_due, updated_at = now() WHERE id = e.e_id;
        EXIT;
      END IF;

      IF p_now - st.s_due > make_interval(days => e.tolerance_days) THEN  -- atrasada demais: nunca sai "em rajada"
        INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, status, due_at, send_key, reserved_at)
        VALUES (p_account, e.e_id, e.e_contact, st.s_id, 'expired', st.s_due, 'regua:' || e.e_id || ':' || st.s_id, p_now)
        ON CONFLICT DO NOTHING;
        CONTINUE;
      END IF;

      SELECT count(*) INTO v_count  -- uma leitura de índice (contact_id, reserved_at): custo constante por inscrição
        FROM wacrm.billing_step_sends x
       WHERE x.contact_id = e.e_contact
         AND x.reserved_at >= v_day_start AND x.reserved_at < v_day_end
         AND x.status NOT IN ('expired', 'cancelled', 'deferred', 'quality_blocked');
      -- Decisão do dono (09/10): a campanha MANUAL conta junto no teto diário do devedor. Só o que JÁ SAIU hoje (índice
      -- contact_id, sent_at da migration 126); o que a régua enfileirou já está contado acima (origem 'regua' fica de fora p/ não duplicar).
      IF v_manual_counts THEN
        SELECT v_count + count(*) INTO v_count
          FROM wacrm.disp_message_queue q
         WHERE q.contact_id = e.e_contact AND q.origem = 'manual'
           AND q.sent_at >= v_day_start AND q.sent_at < v_day_end;
      END IF;
      IF v_count >= e.cap THEN  -- teto diário do devedor: tenta de novo amanhã, no começo da janela
        UPDATE wacrm.billing_enrollments
           SET next_step_at = (((v_today + 1) + e.window_start) AT TIME ZONE 'America/Sao_Paulo'), updated_at = now()
         WHERE id = e.e_id;
        EXIT;
      END IF;

      INSERT INTO wacrm.billing_step_sends (account_id, enrollment_id, contact_id, step_id, status, due_at, send_key, reserved_at)
      VALUES (p_account, e.e_id, e.e_contact, st.s_id, 'reserved', st.s_due, 'regua:' || e.e_id || ':' || st.s_id, p_now)
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN CONTINUE; END IF;  -- outra execução reservou primeiro

      send_id := v_id; enrollment_id := e.e_id; step_id := st.s_id; account_id := p_account; ruler_id := e.e_ruler; debt_id := e.e_debt;
      contact_id := e.e_contact; channel_id := e.e_channel; send_key := 'regua:' || e.e_id || ':' || st.s_id; due_at := st.s_due;
      template_id := st.s_template; message_text := st.s_text; due_date := e.e_due; amount_cents := e.e_amount; external_ref := e.e_ref;
      RETURN NEXT;
      v_id := NULL;
    END LOOP;
  END LOOP;
END;
$$;

-- ---- resultado da fila → billing_step_sends ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.billing_reconcile_sends(p_account uuid, p_limit integer DEFAULT 2000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_n integer;
BEGIN
  WITH due AS (
    SELECT s.id
      FROM wacrm.billing_step_sends s
     WHERE s.account_id = p_account AND s.status = 'enqueued' AND s.queue_item_id IS NOT NULL
     ORDER BY s.updated_at
     LIMIT greatest(1, least(coalesce(p_limit, 2000), 20000))
  ), changed AS (
    UPDATE wacrm.billing_step_sends s
       SET status = CASE
                      WHEN q.status = 'entregue' THEN 'sent'
                      WHEN q.status = 'cancelado' THEN 'cancelled'
                      ELSE 'error'
                    END,
           error_code = CASE
                          WHEN q.status = 'entregue' THEN NULL
                          WHEN q.status = 'cancelado' THEN 'queue_cancelled'
                          ELSE left(coalesce(q.erro_codigo::text, 'queue_error'), 100)
                        END,
           updated_at = now()
      FROM due, wacrm.disp_message_queue q
     WHERE s.id = due.id AND q.id = s.queue_item_id
       AND (q.status IN ('entregue', 'cancelado') OR (q.status = 'erro' AND q.erro_permanente IS TRUE))
    RETURNING s.id
  )
  SELECT count(*) INTO v_n FROM changed;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.billing_reconcile_sends(uuid, integer), wacrm.billing_claim_due_steps(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.billing_reconcile_sends(uuid, integer), wacrm.billing_claim_due_steps(uuid, integer, timestamptz) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('279_billing_enqueue') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
