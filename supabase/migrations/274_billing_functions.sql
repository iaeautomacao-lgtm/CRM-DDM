-- ============================================================
-- 274_billing_functions.sql   (PRD 17, PR 17.1 — régua de cobrança: o MOTOR em SQL, atômico e idempotente)
--
-- Funções (SECURITY DEFINER, só service_role; o cron do motor da PR 17.3 só as chama):
--   billing_step_due_at(due_date, offset_days, window_start)   quando uma etapa fica devida (Brasília): (vencimento + offset) às window_start
--   billing_enroll_open_debts(account, ruler, now)             inscreve as dívidas ABERTAS que ainda têm etapa a cumprir (dentro da tolerância)
--   billing_claim_due_steps(account, limit, now)               reserva as etapas devidas: FOR UPDATE SKIP LOCKED + UNIQUE (inscrição, etapa)
--                                                              ⇒ nunca duas vezes, mesmo com ticks concorrentes. Respeita janela/dias da régua,
--                                                              teto por devedor/dia e tolerância (etapa atrasada demais vira 'expired', nunca "rajada").
--                                                              Régua inativa ou em dry-run NUNCA reserva.
--   billing_stop_enrollments(account, reason, debt, contact)   parada por motivo (enum fechado) + cancela envios ainda não saídos
--   billing_should_send(send_id)                               guarda de PRÉ-ENVIO (3ª rede de proteção): inscrição ativa, dívida aberta, régua ligada,
--                                                              número fora da blacklist; senão cancela a etapa e diz o porquê
--   billing_dry_run(account, ruler, date)                      quantas etapas sairiam numa data, sem criar nada
-- Teto diário: nesta PR conta só os envios da própria régua (no mesmo contato); a campanha manual passa a contar junto na PR 17.4
-- (coluna `origem`, decisão do dono).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.billing_rulers'), to_regclass('wacrm.billing_ruler_steps'), to_regclass('wacrm.billing_debts'),
--                    to_regclass('wacrm.billing_enrollments'), to_regclass('wacrm.billing_step_sends');   -- todos não nulos (270–273)
--             SELECT to_regprocedure('wacrm.blacklisted_phone_keys(text[])'), to_regprocedure('wacrm.phone_key(text)');   -- 167 (se NULL, a guarda usa a tabela blacklist direto)
-- ROLLBACK:   BEGIN; DROP FUNCTION IF EXISTS wacrm.billing_step_due_at(date, integer, time), wacrm.billing_enroll_open_debts(uuid, uuid, timestamptz),
--               wacrm.billing_claim_due_steps(uuid, integer, timestamptz), wacrm.billing_stop_enrollments(uuid, text, uuid, uuid),
--               wacrm.billing_should_send(uuid), wacrm.billing_dry_run(uuid, uuid, date);
--             DELETE FROM wacrm.schema_migrations WHERE version = '274_billing_functions'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.billing_rulers') IS NULL OR to_regclass('wacrm.billing_ruler_steps') IS NULL OR to_regclass('wacrm.billing_debts') IS NULL
     OR to_regclass('wacrm.billing_enrollments') IS NULL OR to_regclass('wacrm.billing_step_sends') IS NULL THEN
    RAISE EXCEPTION '274: faltam as tabelas das migrations 270–273';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.billing_step_due_at(p_due date, p_offset integer, p_start time)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$ SELECT ((p_due + p_offset) + p_start) AT TIME ZONE 'America/Sao_Paulo' $$;

CREATE OR REPLACE FUNCTION wacrm.billing_enroll_open_debts(p_account uuid, p_ruler uuid, p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO wacrm.billing_enrollments (account_id, ruler_id, debt_id, next_step_at)
  SELECT ru.account_id, ru.id, d.id, x.due_at
    FROM wacrm.billing_rulers ru
    JOIN wacrm.billing_debts d ON d.account_id = ru.account_id AND d.status = 'open'
    CROSS JOIN LATERAL (
      SELECT min(wacrm.billing_step_due_at(d.due_date, s.offset_days, ru.window_start)) AS due_at
        FROM wacrm.billing_ruler_steps s
       WHERE s.ruler_id = ru.id AND s.active AND s.kind = 'offset'
         AND wacrm.billing_step_due_at(d.due_date, s.offset_days, ru.window_start) >= p_now - make_interval(days => ru.tolerance_days)
    ) x
   WHERE ru.id = p_ruler AND ru.account_id = p_account AND x.due_at IS NOT NULL
  ON CONFLICT (ruler_id, debt_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

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

CREATE OR REPLACE FUNCTION wacrm.billing_stop_enrollments(p_account uuid, p_reason text, p_debt uuid DEFAULT NULL, p_contact uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('paid', 'agreement', 'opt_out', 'blacklist', 'cancelled', 'contact_removed', 'ruler_disabled', 'manual') THEN
    RAISE EXCEPTION 'billing_stop_enrollments: motivo inválido %', p_reason;
  END IF;
  IF p_debt IS NULL AND p_contact IS NULL THEN
    RAISE EXCEPTION 'billing_stop_enrollments: informe a dívida ou o contato';
  END IF;

  WITH stopped AS (
    UPDATE wacrm.billing_enrollments en
       SET status = 'stopped', stop_reason = p_reason, stopped_at = now(), next_step_at = NULL, updated_at = now()
      FROM wacrm.billing_debts d
     WHERE d.id = en.debt_id AND en.account_id = p_account AND en.status IN ('active', 'paused')
       AND ((p_debt IS NOT NULL AND d.id = p_debt) OR (p_contact IS NOT NULL AND d.contact_id = p_contact))
    RETURNING en.id
  ), cancelled AS (
    UPDATE wacrm.billing_step_sends s
       SET status = 'cancelled', error_code = p_reason, updated_at = now()
     WHERE s.enrollment_id IN (SELECT id FROM stopped) AND s.status IN ('reserved', 'enqueued')
    RETURNING s.id
  )
  SELECT count(*) INTO v_n FROM stopped;

  IF p_debt IS NOT NULL AND p_reason IN ('paid', 'agreement', 'cancelled') THEN
    UPDATE wacrm.billing_debts
       SET status = CASE p_reason WHEN 'paid' THEN 'paid' WHEN 'agreement' THEN 'agreement' ELSE 'cancelled' END
     WHERE id = p_debt AND account_id = p_account AND status = 'open';
  END IF;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.billing_should_send(p_send_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  r record;
  v_reason text;
  v_blocked boolean := false;
BEGIN
  SELECT s.id, s.status AS send_status, s.enrollment_id, en.status AS en_status, ru.active AS ru_active, ru.dry_run, d.status AS debt_status,
         d.account_id, c.phone
    INTO r
    FROM wacrm.billing_step_sends s
    JOIN wacrm.billing_enrollments en ON en.id = s.enrollment_id
    JOIN wacrm.billing_rulers ru ON ru.id = en.ruler_id
    JOIN wacrm.billing_debts d ON d.id = en.debt_id
    LEFT JOIN wacrm.contacts c ON c.id = d.contact_id
   WHERE s.id = p_send_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'send_not_found'); END IF;
  IF r.send_status NOT IN ('reserved', 'enqueued') THEN RETURN jsonb_build_object('ok', false, 'reason', 'send_not_pending'); END IF;

  IF r.en_status <> 'active' THEN v_reason := 'enrollment_not_active';
  ELSIF NOT r.ru_active OR r.dry_run THEN v_reason := 'ruler_inactive';
  ELSIF r.debt_status <> 'open' THEN v_reason := 'debt_' || r.debt_status;
  ELSIF r.phone IS NULL THEN v_reason := 'contact_removed';
  ELSE
    IF to_regprocedure('wacrm.blacklisted_phone_keys(text[])') IS NOT NULL AND to_regprocedure('wacrm.phone_key(text)') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM wacrm.blacklisted_phone_keys(ARRAY[wacrm.phone_key($1)]))' INTO v_blocked USING r.phone;
    ELSIF to_regclass('wacrm.blacklist') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM wacrm.blacklist b WHERE regexp_replace(coalesce(b.telefone, ''''), ''\D'', '''', ''g'') = regexp_replace($1, ''\D'', '''', ''g''))'
        INTO v_blocked USING r.phone;
    END IF;
    IF v_blocked THEN v_reason := 'blacklisted'; END IF;
  END IF;

  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', true, 'reason', NULL); END IF;

  UPDATE wacrm.billing_step_sends SET status = 'cancelled', error_code = v_reason, updated_at = now() WHERE id = p_send_id;
  IF v_reason = 'blacklisted' THEN
    UPDATE wacrm.billing_enrollments SET status = 'stopped', stop_reason = 'blacklist', stopped_at = now(), next_step_at = NULL, updated_at = now()
     WHERE id = r.enrollment_id AND status IN ('active', 'paused');
  END IF;
  RETURN jsonb_build_object('ok', false, 'reason', v_reason);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.billing_dry_run(p_account uuid, p_ruler uuid, p_date date)
RETURNS TABLE (step_id uuid, offset_days integer, debts bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = wacrm, public
AS $$
  SELECT s.id, s.offset_days, count(d.id)
    FROM wacrm.billing_rulers ru
    JOIN wacrm.billing_ruler_steps s ON s.ruler_id = ru.id AND s.active AND s.kind = 'offset'
    LEFT JOIN wacrm.billing_debts d
           ON d.account_id = ru.account_id AND d.status = 'open' AND d.due_date + s.offset_days = p_date
          AND NOT EXISTS (SELECT 1 FROM wacrm.billing_enrollments en JOIN wacrm.billing_step_sends x ON x.enrollment_id = en.id
                           WHERE en.ruler_id = ru.id AND en.debt_id = d.id AND x.step_id = s.id)
   WHERE ru.id = p_ruler AND ru.account_id = p_account
   GROUP BY s.id, s.offset_days
   ORDER BY s.offset_days
$$;

REVOKE ALL ON FUNCTION wacrm.billing_step_due_at(date, integer, time), wacrm.billing_enroll_open_debts(uuid, uuid, timestamptz),
  wacrm.billing_claim_due_steps(uuid, integer, timestamptz), wacrm.billing_stop_enrollments(uuid, text, uuid, uuid),
  wacrm.billing_should_send(uuid), wacrm.billing_dry_run(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.billing_step_due_at(date, integer, time), wacrm.billing_enroll_open_debts(uuid, uuid, timestamptz),
  wacrm.billing_claim_due_steps(uuid, integer, timestamptz), wacrm.billing_stop_enrollments(uuid, text, uuid, uuid),
  wacrm.billing_should_send(uuid), wacrm.billing_dry_run(uuid, uuid, date) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('274_billing_functions') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
