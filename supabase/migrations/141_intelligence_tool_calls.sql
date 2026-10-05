-- ============================================================
-- 141_intelligence_tool_calls.sql — auditoria do DDM Intelligence (PRD-04)
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
-- Conferir o schema live antes (CLAUDE.md): wacrm.accounts e
-- wacrm.profiles(account_id, account_role) precisam existir (017).
-- Depois da 139 e da 140 (papel supervisor).
--
-- Uma linha por chamada de ferramenta (src/lib/intelligence/audit.ts):
-- quem chamou, qual ferramenta, argumentos, duração, sucesso, tamanho do
-- resultado e erro. Nunca guarda o resultado em si.
--
-- Escrita só pelo servidor (service_role). Leitura: owner/admin da conta
-- (mesma regra de audit_logs na 131) — supervisor não lê a auditoria.
--
-- Idempotente.
-- ============================================================

BEGIN;

SET search_path TO wacrm, public, extensions;

CREATE TABLE IF NOT EXISTS wacrm.intelligence_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  success boolean NOT NULL,
  result_size integer CHECK (result_size IS NULL OR result_size >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_intelligence_tool_calls_account_created
  ON wacrm.intelligence_tool_calls (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_tool_calls_account_tool
  ON wacrm.intelligence_tool_calls (account_id, tool_name, created_at DESC);

ALTER TABLE wacrm.intelligence_tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intelligence_tool_calls_select ON wacrm.intelligence_tool_calls;
CREATE POLICY intelligence_tool_calls_select ON wacrm.intelligence_tool_calls FOR SELECT
  TO authenticated
  USING (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id = intelligence_tool_calls.account_id
        AND p.account_role IN ('owner', 'admin')
    )
  );

REVOKE ALL ON wacrm.intelligence_tool_calls FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON wacrm.intelligence_tool_calls FROM authenticated;
GRANT SELECT ON wacrm.intelligence_tool_calls TO authenticated;
GRANT ALL ON wacrm.intelligence_tool_calls TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
