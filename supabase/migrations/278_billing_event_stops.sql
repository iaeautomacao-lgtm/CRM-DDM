-- ============================================================
-- 278_billing_event_stops.sql   (PRD 17, PR 17.3 — régua de cobrança: parada automática por evento do CRM)
--
-- Paradas que a régua precisa SEM esperar a DDM (as duas outras redes: sincronização pontual antes de cobrar e billing_should_send no envio):
--   1. ACORDO fechado no CRM — trigger em wacrm.conversations: quando a tabulação (outcome_tag_id) passa a ser a 142 "Acordo Realizado"
--      (mesmo código de src/lib/ai/acordo-tagging.ts), as inscrições do CONTATO são paradas com motivo 'agreement' na mesma transação.
--      Só trabalha se o contato tem inscrição ativa/pausada (uma consulta indexada); à prova de falha (nunca derruba a escrita).
--   2. OPT-OUT / BLACKLIST — wacrm.billing_stop_blacklisted(conta, janela, limite): em lote, para as inscrições cujo número está na
--      blacklist, olhando só as que têm etapa devida na janela (24 h por padrão). O motor chama a cada tick (stateless). Em lote de
--      propósito: um trigger por linha de blacklist varreria inscrições a cada bloqueio (importação de blacklist em massa).
--      Usa wacrm.phone_key / blacklisted_phone_keys da 167 (mesma regra de equivalência de número do disparador).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.billing_enrollments'), to_regprocedure('wacrm.billing_stop_enrollments(uuid,text,uuid,uuid)');  -- 272/274
--             SELECT to_regprocedure('wacrm.phone_key(text)'), to_regprocedure('wacrm.blacklisted_phone_keys(text[])');                   -- 167
--             SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='tags' AND column_name='codigo_tabulacao'; -- 041
-- ORDEM: depois da 274. Idempotente.
-- ROLLBACK:   BEGIN; DROP TRIGGER IF EXISTS trg_billing_agreement ON wacrm.conversations;
--             DROP FUNCTION IF EXISTS wacrm.billing_on_agreement(), wacrm.billing_stop_blacklisted(uuid, interval, integer);
--             DELETE FROM wacrm.schema_migrations WHERE version = '278_billing_event_stops'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.billing_enrollments') IS NULL OR to_regprocedure('wacrm.billing_stop_enrollments(uuid,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '278: faltam as migrations 272 e 274 (régua)';
  END IF;
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.tags') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '278: faltam wacrm.conversations/tags/contacts';
  END IF;
  IF to_regprocedure('wacrm.phone_key(text)') IS NULL OR to_regprocedure('wacrm.blacklisted_phone_keys(text[])') IS NULL THEN
    RAISE EXCEPTION '278: falta a migration 167 (phone_key / blacklisted_phone_keys)';
  END IF;
END $$;

-- ---- acordo fechado no CRM ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.billing_on_agreement()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_code integer;
BEGIN
  IF NEW.outcome_tag_id IS NULL OR NEW.account_id IS NULL OR NEW.contact_id IS NULL THEN RETURN NULL; END IF;
  SELECT t.codigo_tabulacao INTO v_code FROM wacrm.tags t WHERE t.id = NEW.outcome_tag_id;
  IF v_code IS DISTINCT FROM 142 THEN RETURN NULL; END IF;
  -- barato: só segue se o contato tem dívida com inscrição viva (índice idx_billing_debts_contact)
  IF NOT EXISTS (
    SELECT 1 FROM wacrm.billing_debts d JOIN wacrm.billing_enrollments en ON en.debt_id = d.id AND en.status IN ('active', 'paused')
     WHERE d.contact_id = NEW.contact_id AND d.account_id = NEW.account_id
  ) THEN RETURN NULL; END IF;
  PERFORM wacrm.billing_stop_enrollments(NEW.account_id, 'agreement', NULL, NEW.contact_id);
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'billing_on_agreement falhou: %', SQLERRM;  -- nunca derruba a escrita original
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.billing_on_agreement() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_billing_agreement ON wacrm.conversations;
CREATE TRIGGER trg_billing_agreement AFTER UPDATE OF outcome_tag_id ON wacrm.conversations
  FOR EACH ROW WHEN (NEW.outcome_tag_id IS NOT NULL AND OLD.outcome_tag_id IS DISTINCT FROM NEW.outcome_tag_id)
  EXECUTE FUNCTION wacrm.billing_on_agreement();

-- ---- opt-out / blacklist (em lote, no tick) ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.billing_stop_blacklisted(p_account uuid, p_within interval DEFAULT interval '24 hours', p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_ids uuid[];
  v_keys text[];
  v_blocked text[];
  v_n integer := 0;
BEGIN
  SELECT array_agg(x.eid), array_agg(DISTINCT x.k)
    INTO v_ids, v_keys
    FROM (
      SELECT en.id AS eid, wacrm.phone_key(c.phone) AS k
        FROM wacrm.billing_enrollments en
        JOIN wacrm.billing_debts d ON d.id = en.debt_id
        JOIN wacrm.contacts c ON c.id = d.contact_id
       WHERE en.account_id = p_account AND en.status IN ('active', 'paused')
         AND en.next_step_at IS NOT NULL AND en.next_step_at <= now() + p_within
       ORDER BY en.next_step_at
       LIMIT greatest(1, least(coalesce(p_limit, 5000), 50000))
    ) x;
  IF v_ids IS NULL THEN RETURN 0; END IF;

  SELECT array_agg(b.key) INTO v_blocked FROM wacrm.blacklisted_phone_keys(v_keys) b;
  IF v_blocked IS NULL THEN RETURN 0; END IF;

  WITH stopped AS (
    UPDATE wacrm.billing_enrollments en
       SET status = 'stopped', stop_reason = 'blacklist', stopped_at = now(), next_step_at = NULL, updated_at = now()
      FROM wacrm.billing_debts d, wacrm.contacts c
     WHERE en.id = ANY (v_ids) AND en.status IN ('active', 'paused')
       AND d.id = en.debt_id AND c.id = d.contact_id AND wacrm.phone_key(c.phone) = ANY (v_blocked)
    RETURNING en.id
  ), cancelled AS (
    UPDATE wacrm.billing_step_sends s
       SET status = 'cancelled', error_code = 'blacklist', updated_at = now()
     WHERE s.enrollment_id IN (SELECT id FROM stopped) AND s.status IN ('reserved', 'enqueued')
    RETURNING s.id
  )
  SELECT count(*) INTO v_n FROM stopped;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.billing_stop_blacklisted(uuid, interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.billing_stop_blacklisted(uuid, interval, integer) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('278_billing_event_stops') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
