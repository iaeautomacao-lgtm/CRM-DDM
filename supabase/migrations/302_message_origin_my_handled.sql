-- ============================================================
-- 302_message_origin_my_handled.sql   (TASK1 item 6 — Inbox: opcionais do PRD 23, itens 17 e 21 fase 2)
--
-- ⚠️ APLICAR ANTES DO DEPLOY DO CÓDIGO: o código passa a gravar `messages.origin` nos envios de IA, fluxo, automação, campanha e API.
--    Sem esta migration, esses INSERTs falham (coluna inexistente).
--
-- 1) ORIGEM DA MENSAGEM (item 21, fase 2): wacrm.messages.origin text NULL, um de
--      'customer' | 'operator' | 'ai' | 'flow' | 'campaign' | 'automation' | 'api'
--    Quem grava define (IA = responder; fluxo = envio do motor; campanha = reconstrução do disparo; automação; API pública;
--    atendente = rota de envio do Inbox). Trigger BEFORE INSERT preenche o que nenhum escritor definiu:
--      customer → 'customer'; agent COM sender_id → 'operator'. Mensagens de bot/eco sem origem ficam NULL (o front trata NULL
--      como "Automação" genérica). SEM backfill: o histórico antigo continua NULL (tabela quente; backfill em lote fica opcional).
-- 2) MEUS ATENDIDOS (item 17): wacrm.inbox_my_handled(p_before, p_before_id, p_limit, p_days) → conversas que o usuário atendeu e
--    transferiu (conversation_assignments.from_agent_id = ele, hoje com outro atendente ou sem), mais recente transferência por
--    conversa, janela de p_days (padrão 90, máx 365). SECURITY DEFINER porque a RLS de conversations esconde do agente a conversa
--    que saiu dele; só devolve ids e dados do próprio histórico dele (auth.uid()), sempre da conta dele.
--    O índice de apoio está na 302b (CONCURRENTLY, rodar sozinha).
--
-- PRÉ-CHECK:  SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='messages' AND column_name='origin';  -- 0 linhas
--             SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--              WHERE n.nspname='wacrm' AND p.proname IN ('inbox_my_handled','set_message_origin');                                  -- 0 linhas
-- ROLLBACK:   DROP TRIGGER IF EXISTS trg_set_message_origin ON wacrm.messages;
--             DROP FUNCTION IF EXISTS wacrm.set_message_origin(), wacrm.inbox_my_handled(timestamptz, uuid, integer, integer);
--             ALTER TABLE wacrm.messages DROP COLUMN IF EXISTS origin;   -- (o código novo precisa ser revertido ANTES)
--             DELETE FROM wacrm.schema_migrations WHERE version = '302_message_origin_my_handled';
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.messages') IS NULL OR to_regclass('wacrm.conversation_assignments') IS NULL
     OR to_regclass('wacrm.conversations') IS NULL THEN
    RAISE EXCEPTION '302: faltam wacrm.messages/conversations/conversation_assignments';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'wacrm' AND p.proname = 'current_account_id') THEN
    RAISE EXCEPTION '302: wacrm.current_account_id() não existe (migration 170)';
  END IF;
END $$;

-- ---------- 1) origem da mensagem ----------
ALTER TABLE wacrm.messages ADD COLUMN IF NOT EXISTS origin text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_origin_chk' AND conrelid = 'wacrm.messages'::regclass) THEN
    ALTER TABLE wacrm.messages ADD CONSTRAINT messages_origin_chk
      CHECK (origin IS NULL OR origin IN ('customer', 'operator', 'ai', 'flow', 'campaign', 'automation', 'api')) NOT VALID;
    ALTER TABLE wacrm.messages VALIDATE CONSTRAINT messages_origin_chk;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.set_message_origin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.origin IS NULL THEN
    IF NEW.sender_type = 'customer' THEN
      NEW.origin := 'customer';
    ELSIF NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL THEN
      NEW.origin := 'operator';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_message_origin ON wacrm.messages;
CREATE TRIGGER trg_set_message_origin
  BEFORE INSERT ON wacrm.messages
  FOR EACH ROW EXECUTE FUNCTION wacrm.set_message_origin();

-- ---------- 2) meus atendidos ----------
CREATE OR REPLACE FUNCTION wacrm.inbox_my_handled(
  p_before timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_days integer DEFAULT 90
)
RETURNS TABLE (conversation_id uuid, transferred_at timestamptz, to_agent_id uuid, to_team_id uuid, reason text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH me AS (
    SELECT auth.uid() AS uid, wacrm.current_account_id() AS account_id
  ), last_transfer AS (
    SELECT DISTINCT ON (ca.conversation_id)
           ca.conversation_id, ca.created_at, ca.to_agent_id, ca.to_team_id, ca.reason
      FROM wacrm.conversation_assignments ca
      JOIN me ON ca.account_id = me.account_id AND ca.from_agent_id = me.uid
      JOIN wacrm.conversations c ON c.id = ca.conversation_id AND c.account_id = me.account_id
     WHERE me.uid IS NOT NULL
       AND ca.to_agent_id IS DISTINCT FROM me.uid
       AND c.assigned_agent_id IS DISTINCT FROM me.uid
       AND ca.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 90), 1), 365))
     ORDER BY ca.conversation_id, ca.created_at DESC
  )
  SELECT lt.conversation_id, lt.created_at, lt.to_agent_id, lt.to_team_id, lt.reason
    FROM last_transfer lt
   WHERE p_before IS NULL
      OR lt.created_at < p_before
      OR (lt.created_at = p_before AND p_before_id IS NOT NULL AND lt.conversation_id < p_before_id)
   ORDER BY lt.created_at DESC, lt.conversation_id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
$$;
REVOKE ALL ON FUNCTION wacrm.inbox_my_handled(timestamptz, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.inbox_my_handled(timestamptz, uuid, integer, integer) TO authenticated, service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('302_message_origin_my_handled') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
