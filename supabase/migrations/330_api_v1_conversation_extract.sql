-- ============================================================
-- 330_api_v1_conversation_extract.sql   (TASK38 — API v1: extrair conversas e mensagens)
--
-- Duas funções SÓ para o service role (a API v1 autentica por chave e filtra por conta explicitamente; nada de anon/authenticated):
--   wacrm.api_v1_messages(...)  — uma página de mensagens em ordem (created_at, id), com o `seq` (posição 1..N dentro da conversa)
--     calculado NO BANCO: a mesma consulta serve a lista de uma conversa e a extração em massa por período, e o seq continua correto
--     mesmo quando a página começa no meio da conversa (conta as anteriores pelo índice (account_id, conversation_id, created_at)).
--     Escopo: messages.account_id E conversations.account_id = p_account_id (as duas pontas da conta). Só colunas públicas da
--     mensagem; nada de prompt/decisão da IA, notas internas ou chat interno (outras tabelas).
--   wacrm.api_v1_conversation_message_counts(p_account_id, p_ids) — message_count de várias conversas numa única agregação
--     (a lista de conversas não faz uma contagem por linha).
--
-- Depende da 302 (messages.origin). Índices de apoio: 330b e 331b (CONCURRENTLY, cada uma SOZINHA); as funções funcionam sem eles.
--
-- PRÉ-CHECK: SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='messages' AND column_name='origin';  -- 1 linha
-- VERIFICAÇÃO: SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND proname LIKE 'api_v1_%';   -- 2 linhas
-- ORDEM: depois da 302. Sem esta migration as rotas novas respondem 503.
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.api_v1_messages(uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, text, uuid, integer);
--           DROP FUNCTION IF EXISTS wacrm.api_v1_conversation_message_counts(uuid, uuid[]);
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.messages') IS NULL OR to_regclass('wacrm.conversations') IS NULL THEN
    RAISE EXCEPTION '330: faltam wacrm.messages/conversations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'messages' AND column_name = 'origin') THEN
    RAISE EXCEPTION '330: falta wacrm.messages.origin — aplique a migration 302 antes';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.api_v1_messages(
  p_account_id      uuid,
  p_conversation_id uuid        DEFAULT NULL,
  p_from            timestamptz DEFAULT NULL,
  p_to              timestamptz DEFAULT NULL,
  p_after_at        timestamptz DEFAULT NULL,
  p_after_id        uuid        DEFAULT NULL,
  p_channel         text        DEFAULT NULL,
  p_team_id         uuid        DEFAULT NULL,
  p_limit           integer     DEFAULT 500
)
RETURNS TABLE (
  id                  uuid,
  conversation_id     uuid,
  seq                 bigint,
  created_at          timestamptz,
  sender_type         text,
  sender_id           uuid,
  origin              text,
  content_type        text,
  content_text        text,
  media_url           text,
  template_name       text,
  status              text,
  reply_to_message_id uuid,
  campaign_id         uuid,
  contact_id          uuid
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH page AS (
    SELECT m.id, m.conversation_id, m.created_at, m.sender_type, m.sender_id, m.origin, m.content_type, m.content_text,
           m.media_url, m.template_name, m.status, m.reply_to_message_id, m.campaign_id, c.contact_id
    FROM wacrm.messages m
    JOIN wacrm.conversations c ON c.id = m.conversation_id AND c.account_id = p_account_id
    WHERE m.account_id = p_account_id
      AND (p_conversation_id IS NULL OR m.conversation_id = p_conversation_id)
      AND (p_from IS NULL OR m.created_at >= p_from)
      AND (p_to IS NULL OR m.created_at < p_to)
      AND (p_after_at IS NULL OR (m.created_at, m.id) > (p_after_at, p_after_id))
      AND (p_channel IS NULL OR COALESCE(c.channel_type, 'whatsapp') = p_channel)
      AND (p_team_id IS NULL OR c.team_id = p_team_id)
    ORDER BY m.created_at, m.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000)
  )
  SELECT p.id, p.conversation_id,
         (SELECT count(*) FROM wacrm.messages s
           WHERE s.account_id = p_account_id AND s.conversation_id = p.conversation_id
             AND (s.created_at, s.id) <= (p.created_at, p.id)) AS seq,
         p.created_at, p.sender_type, p.sender_id, p.origin, p.content_type, p.content_text,
         p.media_url, p.template_name, p.status, p.reply_to_message_id, p.campaign_id, p.contact_id
  FROM page p
  ORDER BY p.created_at, p.id;
$$;

REVOKE ALL ON FUNCTION wacrm.api_v1_messages(uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.api_v1_messages(uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, text, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION wacrm.api_v1_conversation_message_counts(p_account_id uuid, p_ids uuid[])
RETURNS TABLE (conversation_id uuid, message_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.conversation_id, count(*)
  FROM wacrm.messages m
  WHERE m.account_id = p_account_id AND m.conversation_id = ANY (p_ids)
  GROUP BY m.conversation_id;
$$;

REVOKE ALL ON FUNCTION wacrm.api_v1_conversation_message_counts(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.api_v1_conversation_message_counts(uuid, uuid[]) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('330_api_v1_conversation_extract') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
