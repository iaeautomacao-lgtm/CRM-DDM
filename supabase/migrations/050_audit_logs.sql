-- ============================================================
-- 050_audit_logs.sql — Audit log foundation for Relatórios/Auditoria
--
-- Records created/updated/deleted events on contacts and
-- conversations: who did it, when, from which IP, and what changed
-- (before/after). Inspired by Fortics Chat Center's audit screen.
--
-- Two write paths:
--   1. DB triggers below (system-side changes: webhooks, automations,
--      any direct SQL) — no user/IP context available, so user_id/
--      ip_address stay NULL and user_name stays NULL.
--   2. src/lib/audit/log-event.ts's logAuditEvent() (manual UI
--      actions) — called from route handlers where we have the
--      authenticated user and request IP.
--
-- Append-only, like flow_run_events (010_flows.sql) — RLS below only
-- grants SELECT. There is no INSERT policy for `authenticated` on
-- purpose: both legitimate writers (the SECURITY DEFINER trigger
-- functions, owned by the table owner, and the service_role client in
-- log-event.ts) already bypass RLS, so a permissive INSERT policy
-- would only be reachable by an ordinary authenticated user forging
-- audit_logs rows with an arbitrary account_id. Do not add one.
--
-- Column names in the trigger functions below were checked against
-- the actual current schema (src/types/index.ts + migrations), not
-- assumed:
--   - contacts:      name, phone, email, company (phone_normalized is
--                     a GENERATED column derived from phone — 022 — so
--                     it's redundant to audit separately).
--   - conversations:  status, assigned_agent_id, team_id, waha_session.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ---- table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.audit_logs (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  event_type     TEXT        NOT NULL CHECK (event_type IN ('created', 'updated', 'deleted')),
  resource_type  TEXT        NOT NULL, -- 'contact' | 'conversation' (more later)
  resource_id    UUID        NOT NULL,
  resource_label TEXT,                 -- human-readable name/identifier at event time
  user_id        UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  user_name      TEXT,                 -- snapshot of the actor's name at event time
  ip_address     TEXT,
  changes        JSONB,                -- {field: {before: value, after: value}}
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_account_created
  ON wacrm.audit_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource
  ON wacrm.audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS audit_logs_user
  ON wacrm.audit_logs(user_id);

ALTER TABLE wacrm.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select ON wacrm.audit_logs;
CREATE POLICY audit_logs_select ON wacrm.audit_logs FOR SELECT
  USING (is_account_member(account_id));

-- No INSERT/UPDATE/DELETE policy — see header comment. Writes only
-- happen via SECURITY DEFINER triggers or the service_role client,
-- both of which bypass RLS.

-- ============================================================
-- trigger function: contacts
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.audit_contacts_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_changes JSONB := '{}';
  v_col     TEXT;
  v_old     TEXT;
  v_new     TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO wacrm.audit_logs
      (account_id, event_type, resource_type, resource_id, resource_label, created_at)
    VALUES
      (NEW.account_id, 'created', 'contact', NEW.id, NEW.name, NOW());
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    FOREACH v_col IN ARRAY ARRAY['name', 'phone', 'email', 'company'] LOOP
      EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', v_col, v_col)
        INTO v_old, v_new USING OLD, NEW;
      IF v_old IS DISTINCT FROM v_new THEN
        v_changes := v_changes || jsonb_build_object(
          v_col, jsonb_build_object('before', v_old, 'after', v_new)
        );
      END IF;
    END LOOP;

    IF v_changes <> '{}' THEN
      INSERT INTO wacrm.audit_logs
        (account_id, event_type, resource_type, resource_id, resource_label, changes, created_at)
      VALUES
        (NEW.account_id, 'updated', 'contact', NEW.id, NEW.name, v_changes, NOW());
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO wacrm.audit_logs
      (account_id, event_type, resource_type, resource_id, resource_label, created_at)
    VALUES
      (OLD.account_id, 'deleted', 'contact', OLD.id, OLD.name, NOW());
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_contacts ON wacrm.contacts;
CREATE TRIGGER trg_audit_contacts
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.contacts
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_contacts_changes();

-- ============================================================
-- trigger function: conversations
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.audit_conversations_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_changes JSONB := '{}';
  v_col     TEXT;
  v_old     TEXT;
  v_new     TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO wacrm.audit_logs
      (account_id, event_type, resource_type, resource_id, resource_label, created_at)
    VALUES
      (NEW.account_id, 'created', 'conversation', NEW.id, 'Conversa #' || NEW.id::text, NOW());
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    FOREACH v_col IN ARRAY ARRAY['status', 'assigned_agent_id', 'team_id', 'waha_session'] LOOP
      EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', v_col, v_col)
        INTO v_old, v_new USING OLD, NEW;
      IF v_old IS DISTINCT FROM v_new THEN
        v_changes := v_changes || jsonb_build_object(
          v_col, jsonb_build_object('before', v_old, 'after', v_new)
        );
      END IF;
    END LOOP;

    IF v_changes <> '{}' THEN
      INSERT INTO wacrm.audit_logs
        (account_id, event_type, resource_type, resource_id, resource_label, changes, created_at)
      VALUES
        (NEW.account_id, 'updated', 'conversation', NEW.id, 'Conversa #' || NEW.id::text, v_changes, NOW());
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_conversations ON wacrm.conversations;
CREATE TRIGGER trg_audit_conversations
  AFTER INSERT OR UPDATE ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_conversations_changes();
