-- Migration 094: wacrm.user_sessions — início/fim de sessão por usuário.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- Formato "uma linha por sessão" (started_at + ended_at nullable),
-- diferente do log de evento pontual de system_logs/audit_logs —
-- session_start (POST /api/telemetry) cria a linha e devolve o id;
-- session_end faz o UPDATE de ended_at/page_count nessa mesma linha.
CREATE TABLE IF NOT EXISTS wacrm.user_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  account_id  uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  user_name   text,
  ip_address  text,
  user_agent  text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  page_count  integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON wacrm.user_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_account
  ON wacrm.user_sessions (account_id, started_at DESC);
