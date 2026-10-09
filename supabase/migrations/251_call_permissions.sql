-- ============================================================
-- 251_call_permissions.sql   (PRD 18 — PR-18.1: consentimento / Call Permission do WhatsApp Calling)
--
-- A Meta só deixa o negócio LIGAR para o cliente com a permissão dele (CALL-01): sem ela a ligação é rejeitada (erro 131053) e a qualidade
-- do número pode cair. Esta migration guarda a permissão por (conta, telefone) e responde "posso ligar?" ANTES de chamar a Meta (RF-02).
--
--   wacrm.call_permissions       uma linha por (account_id, phone) — o consentimento mais recente. expires_at = 'infinity' para permanente.
--                                Recusa/revogação do cliente grava expires_at no passado (a linha fica como histórico do último estado).
--   wacrm.record_call_permission()  grava/renova (upsert) — idempotente e monotônico: um evento ATRASADO (granted_at mais antigo que o
--                                já gravado) não sobrescreve um mais novo.
--   wacrm.has_call_permission()     true se existe permissão vigente (expires_at > now()).
--
-- Origens (source): inbound_call (cliente ligou — janela curta de retorno), template_button (botão de pedido de permissão do template),
-- interactive_optin (resposta `call_permission_reply` da mensagem interativa), explicit_chat (cliente aceitou por texto, registrado por humano).
--
-- Acesso: authenticated só LÊ a própria conta (is_account_member); escrita só do servidor (service_role).
-- COMPATIBILIDADE: o app detecta a ausência da migration (42P01/PGRST202/42883) e ignora o registro. ANTES ou DEPOIS do deploy.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.call_permissions');   -- NULL
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.has_call_permission(uuid, text);
--             DROP FUNCTION IF EXISTS wacrm.record_call_permission(uuid, uuid, text, timestamptz, timestamptz, text);
--             DROP TABLE IF EXISTS wacrm.call_permissions;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '251: faltam wacrm.accounts/contacts — confira o schema vivo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '251: wacrm.is_account_member não existe (migration 017/140)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.call_permissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES wacrm.contacts(id) ON DELETE SET NULL,
  phone      text NOT NULL CHECK (phone ~ '^[0-9]{8,20}$'),     -- só dígitos (E.164 sem +)
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,                              -- 'infinity' = permanente; no passado = recusada/revogada
  source     text NOT NULL CHECK (source IN ('inbound_call', 'template_button', 'interactive_optin', 'explicit_chat')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_call_permissions_account_phone UNIQUE (account_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_call_permissions_contact ON wacrm.call_permissions (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE wacrm.call_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.call_permissions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE wacrm.call_permissions TO authenticated;
GRANT ALL ON TABLE wacrm.call_permissions TO service_role;

DROP POLICY IF EXISTS call_permissions_select_member ON wacrm.call_permissions;
CREATE POLICY call_permissions_select_member ON wacrm.call_permissions
  FOR SELECT TO authenticated
  USING (wacrm.is_account_member(account_id));

-- Grava/renova a permissão. Evento mais antigo que o já gravado (granted_at menor) não sobrescreve. Devolve true se gravou.
CREATE OR REPLACE FUNCTION wacrm.record_call_permission(
  p_account_id uuid,
  p_contact_id uuid,
  p_phone text,
  p_granted_at timestamptz,
  p_expires_at timestamptz,
  p_source text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_account_id IS NULL OR p_phone IS NULL OR p_expires_at IS NULL THEN RETURN false; END IF;

  INSERT INTO wacrm.call_permissions(account_id, contact_id, phone, granted_at, expires_at, source)
  VALUES (p_account_id, p_contact_id, p_phone, COALESCE(p_granted_at, now()), p_expires_at, p_source)
  ON CONFLICT (account_id, phone) DO UPDATE
     SET contact_id = COALESCE(EXCLUDED.contact_id, wacrm.call_permissions.contact_id),
         granted_at = EXCLUDED.granted_at,
         expires_at = EXCLUDED.expires_at,
         source = EXCLUDED.source,
         updated_at = now()
   WHERE EXCLUDED.granted_at >= wacrm.call_permissions.granted_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.has_call_permission(p_account_id uuid, p_phone text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM wacrm.call_permissions
     WHERE account_id = p_account_id AND phone = p_phone AND expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION wacrm.record_call_permission(uuid, uuid, text, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.has_call_permission(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.record_call_permission(uuid, uuid, text, timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.has_call_permission(uuid, text) TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('251_call_permissions') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
