-- Migration 093: wacrm.page_views — telemetria de navegação.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- Tabela separada de system_logs (não um novo `source`) porque o
-- volume esperado (uma linha por navegação, de todo usuário ativo) é
-- ordens de magnitude maior que os eventos de warning/erro que
-- system_logs registra hoje — mistura o índice errado (system_logs é
-- otimizado pra "erros recentes por fonte", não pra "todas as
-- navegações de todo mundo") e dificultaria retenção diferenciada
-- (navegação pode ter TTL bem mais curto que log de erro).
CREATE TABLE IF NOT EXISTS wacrm.page_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  account_id  uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  path        text NOT NULL,
  title       text,
  referrer    text,
  duration_ms integer,  -- tempo na página (calculado no leave)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_views_user
  ON wacrm.page_views (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_account
  ON wacrm.page_views (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_path
  ON wacrm.page_views (path, created_at DESC);
