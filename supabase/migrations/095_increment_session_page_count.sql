-- Migration 095: increment atômico de wacrm.user_sessions.page_count.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- `page_count = page_count + 1` não dá pra expressar direto no query
-- builder do Supabase JS (só aceita valores literais, não uma expressão
-- SQL relativa ao valor atual da coluna) — um SELECT+UPDATE em dois
-- round-trips seria não-atômico (lost update sob páginas abertas em
-- abas concorrentes na mesma sessão), mesmo padrão já corrigido nesta
-- sessão para conversations.unread_count e campaign_metrics.
-- increment_session_page_count faz o incremento num único UPDATE.
CREATE OR REPLACE FUNCTION wacrm.increment_session_page_count(
  p_session_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'wacrm', 'public'
AS $$
  UPDATE wacrm.user_sessions
  SET page_count = page_count + 1
  WHERE id = p_session_id
    AND user_id = p_user_id;
$$;
