-- ============================================================
-- 303_internal_chat_reads.sql   (TASK37 item 1 — Chat interno: não lidas e prévia da última mensagem)
--
-- O chat interno (wacrm.internal_messages, 109/110) é 1:1: a "conversa" é o par de usuários. A lista de conversas precisava, para cada
-- colega, da prévia da última mensagem e do contador de não lidas — hoje o front baixa todas as mensagens e calcula no navegador.
--
--   wacrm.internal_chat_reads (user_id, peer_id) PK — registro de leitura por usuário e por conversa: last_read_at = quando EU abri a
--     conversa com aquele colega. RLS: cada um vê/grava SÓ as próprias linhas (e só em conta da qual é membro).
--   wacrm.internal_chat_threads(p_account_id, p_limit) — uma linha por colega com quem há conversa: prévia (140 caracteres; mídia vira
--     "[imagem]"/"[áudio]"/…), data e remetente da última, contagem de não lidas e meu last_read_at. SECURITY INVOKER: a RLS de
--     internal_messages (109: só as mensagens em que o chamador é remetente ou destinatário) continua sendo a fronteira.
--   wacrm.internal_chat_mark_read(p_account_id, p_peer_id) — marca a conversa como lida: grava last_read_at e preenche read_at das
--     mensagens do colega para mim num único UPDATE. Mantém o contador do sino da sidebar (que conta read_at IS NULL) coerente.
--
-- A "não lida" continua definida por internal_messages.read_at IS NULL (fonte única); internal_chat_reads é o registro por conversa.
-- Nada muda nas tabelas existentes. Sem esta migration o front mantém o cálculo antigo.
--
-- PRÉ-CHECK: SELECT to_regclass('wacrm.internal_messages'), to_regprocedure('wacrm.is_account_member(uuid)');   -- não nulos
-- VERIFICAÇÃO: SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND proname LIKE 'internal_chat_%';  -- 2 funções
-- ORDEM: antes ou depois do deploy. O índice de apoio das não lidas é a 303b (CONCURRENTLY, rodar sozinha); as funções funcionam sem ele.
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.internal_chat_threads(uuid, integer); DROP FUNCTION IF EXISTS wacrm.internal_chat_mark_read(uuid, uuid);
--           DROP TABLE IF EXISTS wacrm.internal_chat_reads;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.internal_messages') IS NULL THEN
    RAISE EXCEPTION '303: falta wacrm.internal_messages (migration 109)';
  END IF;
  IF to_regprocedure('wacrm.is_account_member(uuid)') IS NULL THEN
    RAISE EXCEPTION '303: falta wacrm.is_account_member(uuid)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.internal_chat_reads (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  peer_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, peer_id),
  CHECK (user_id <> peer_id)
);

ALTER TABLE wacrm.internal_chat_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.internal_chat_reads FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.internal_chat_reads TO authenticated;
GRANT ALL ON wacrm.internal_chat_reads TO service_role;

DROP POLICY IF EXISTS internal_chat_reads_own ON wacrm.internal_chat_reads;
CREATE POLICY internal_chat_reads_own ON wacrm.internal_chat_reads FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND wacrm.is_account_member(account_id))
  WITH CHECK (user_id = (SELECT auth.uid()) AND wacrm.is_account_member(account_id));

CREATE OR REPLACE FUNCTION wacrm.internal_chat_threads(p_account_id uuid, p_limit integer DEFAULT 200)
RETURNS TABLE (
  peer_id         uuid,
  last_message_id uuid,
  last_preview    text,
  last_at         timestamptz,
  last_sender_id  uuid,
  unread_count    integer,
  last_read_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH me AS (SELECT (SELECT auth.uid()) AS uid),
  mine AS (
    SELECT m.id, m.sender_id, m.created_at, m.content, m.media_type,
           CASE WHEN m.sender_id = me.uid THEN m.recipient_id ELSE m.sender_id END AS peer
    FROM wacrm.internal_messages m, me
    WHERE m.account_id = p_account_id
      AND (m.sender_id = me.uid OR m.recipient_id = me.uid)
  ),
  last AS (
    SELECT DISTINCT ON (peer) peer, id, sender_id, created_at, content, media_type
    FROM mine
    ORDER BY peer, created_at DESC, id DESC
  ),
  unread AS (
    SELECT m.sender_id AS peer, count(*)::integer AS n
    FROM wacrm.internal_messages m, me
    WHERE m.account_id = p_account_id AND m.recipient_id = me.uid AND m.read_at IS NULL
    GROUP BY m.sender_id
  )
  SELECT l.peer,
         l.id,
         CASE
           WHEN l.content <> '' THEN pg_catalog.left(l.content, 140)
           WHEN l.media_type ILIKE 'image%' THEN '[imagem]'
           WHEN l.media_type ILIKE 'audio%' THEN '[áudio]'
           WHEN l.media_type ILIKE 'video%' THEN '[vídeo]'
           ELSE '[arquivo]'
         END,
         l.created_at,
         l.sender_id,
         COALESCE(u.n, 0),
         r.last_read_at
  FROM last l
  LEFT JOIN unread u ON u.peer = l.peer
  LEFT JOIN wacrm.internal_chat_reads r ON r.user_id = (SELECT uid FROM me) AND r.peer_id = l.peer
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
$$;

REVOKE ALL ON FUNCTION wacrm.internal_chat_threads(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.internal_chat_threads(uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION wacrm.internal_chat_mark_read(p_account_id uuid, p_peer_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_me uuid := (SELECT auth.uid());
  v_marked integer;
BEGIN
  IF v_me IS NULL OR p_peer_id IS NULL OR p_peer_id = v_me THEN
    RETURN 0;
  END IF;

  INSERT INTO wacrm.internal_chat_reads (user_id, peer_id, account_id, last_read_at)
  VALUES (v_me, p_peer_id, p_account_id, now())
  ON CONFLICT (user_id, peer_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at, account_id = EXCLUDED.account_id;

  UPDATE wacrm.internal_messages
     SET read_at = now()
   WHERE account_id = p_account_id AND recipient_id = v_me AND sender_id = p_peer_id AND read_at IS NULL;
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  RETURN v_marked;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.internal_chat_mark_read(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.internal_chat_mark_read(uuid, uuid) TO authenticated, service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('303_internal_chat_reads') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
