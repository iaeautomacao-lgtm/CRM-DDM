-- ============================================================
-- 175_account_secrets.sql
--
-- Cofre de variáveis e credenciais POR CONTA (fase 1).
--
--  - variable  : valor em texto (ex.: URL base, nome de campanha) — o admin
--                vê e edita; resolvida por {{var.NOME}} nas ferramentas.
--  - credential: valor CIFRADO (AES-256-GCM, formato iv:ciphertext:authTag do
--                projeto) que NUNCA volta ao navegador — a API só devolve
--                nome, last4 (quando o valor é longo o bastante), hosts e
--                descrição. Resolvida por {{cred.NOME}} e só vai para hosts
--                de allowed_hosts. Obrigatório ter ao menos um host.
--
-- Acesso: RLS ligada, SEM policy, e REVOKE de anon/authenticated — o
-- navegador nunca lê nem escreve a tabela; tudo passa pelas rotas
-- /api/settings/secrets (service role, papel owner/admin para escrever,
-- supervisor+ para listar mascarado) e pelo resolvedor do servidor.
--
-- Auditoria: trigger genérico (migration 131) só com colunas sem valor.
--
-- PRÉ-CHECK (rodar antes; deve devolver NULL — a tabela ainda não existe):
--   SELECT to_regclass('wacrm.account_secrets');
--   SELECT to_regclass('wacrm.accounts');                       -- deve existir
--   SELECT to_regprocedure('wacrm.audit_generic_changes()');    -- opcional
--
-- ORDEM: aplicar ANTES do deploy do código (sem a tabela o resolvedor cai no
-- comportamento antigo e as rotas respondem erro). Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION 'wacrm.accounts não existe';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.account_secrets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL,
  value_plain     text,
  value_encrypted text,
  last4           text,
  allowed_hosts   text[],
  description     text,
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_secrets_name_format CHECK (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT account_secrets_kind_check CHECK (kind IN ('variable', 'credential')),
  CONSTRAINT account_secrets_unique_name UNIQUE (account_id, name),
  -- variável: só texto; credencial: só cifrado + hosts (não vazio) e nunca texto.
  CONSTRAINT account_secrets_variable_shape CHECK (
    kind <> 'variable' OR (value_plain IS NOT NULL AND value_encrypted IS NULL)
  ),
  CONSTRAINT account_secrets_credential_shape CHECK (
    kind <> 'credential' OR (
      value_plain IS NULL
      AND value_encrypted IS NOT NULL
      AND allowed_hosts IS NOT NULL
      AND cardinality(allowed_hosts) > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_account_secrets_account ON wacrm.account_secrets (account_id);

ALTER TABLE wacrm.account_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.account_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.account_secrets TO service_role;

-- Auditoria (sem valores): só se o trigger genérico da 131 existir.
DO $$
BEGIN
  IF to_regprocedure('wacrm.audit_generic_changes()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_audit_account_secrets ON wacrm.account_secrets';
    EXECUTE $t$CREATE TRIGGER trg_audit_account_secrets
      AFTER INSERT OR UPDATE OR DELETE ON wacrm.account_secrets
      FOR EACH ROW EXECUTE FUNCTION wacrm.audit_generic_changes(
        'account_secret', 'Variável/credencial', 'name', 'name,kind,allowed_hosts,description,last4')$t$;
  END IF;
EXCEPTION WHEN others THEN
  -- Auditoria nunca impede a criação da tabela.
  RAISE WARNING 'trigger de auditoria de account_secrets não criado: %', SQLERRM;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
