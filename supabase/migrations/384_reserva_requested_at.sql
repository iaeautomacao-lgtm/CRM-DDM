-- ============================================================
-- 384_reserva_requested_at.sql   (reserva do @operador expira para a fila após 30 min com o operador em pausa ou offline — decisão do dono, 16/10)
--
-- PARA QUÊ: a expiração precisa saber QUANDO a reserva começou. Esta migration guarda isso em wacrm.conversations.requested_at e o mantém
--   sozinha no banco; quem decide e executa a expiração é o cron de retry-assignment (app), com a regra documentada em
--   src/lib/inbox/reservation-expiry.ts. Não edita a 376 nem a 382.
--
-- O QUE FAZ:
--   1. conversations.requested_at timestamptz (nulo = sem reserva; ou reserva anterior a esta migration e já preenchida com a hora da aplicação, abaixo).
--      ADD COLUMN sem default e sem FK: instantâneo.
--   2. Triggers BEFORE INSERT / BEFORE UPDATE em wacrm.conversations (wacrm.sync_mention_requested_at) que mantêm a coluna por si, para QUALQUER
--      caminho que mexa em requested_agent_id (RPC da 376, trigger de assumir/fechar da 376, liberação por desativação da 382, o próprio cron):
--        • requested_agent_id NULL            → requested_at NULL (reserva acabou);
--        • passou a ter um operador / trocou  → requested_at = now() (a reserva começa agora);
--        • mesmo operador de antes            → requested_at fica como estava. Qualquer valor escrito à mão por cliente é ignorado (o navegador
--          não encurta nem estende o prazo).
--      Disparam só quando algo relevante muda (cláusula WHEN): não pesam nas atualizações comuns de conversa (cada mensagem nova).
--   3. Reservas que JÁ existem na aplicação recebem requested_at = now(): o relógio de 30 min delas começa na aplicação (conservador).
--
-- NÃO FAZ: nenhuma regra de expiração no banco, nenhuma tabela nova (sem apply_mfa_policy), nenhum índice novo (a busca por reservas usa o índice parcial
--   conversations_requested_agent_pending_idx da 376; reservas são poucas).
--
-- PRÉ-CHECK (aborta sem alterar nada se faltar algo):
--   SELECT to_regclass('wacrm.conversations');                                                                                   -- não nulo
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'conversations'
--      AND column_name IN ('requested_agent_id', 'assigned_agent_id', 'status');                                                 -- 3 linhas (a 376 cria requested_agent_id)
--   SELECT to_regprocedure('wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)');                                       -- não nulo (376)
-- VERIFICAÇÃO PÓS-APLICAÇÃO:
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'conversations' AND column_name = 'requested_at';  -- 1 linha
--   SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_sync_mention_requested_at_ins', 'trg_sync_mention_requested_at_upd') AND NOT tgisinternal;      -- 2 linhas
--   SELECT count(*) FROM wacrm.conversations WHERE requested_agent_id IS NOT NULL AND requested_at IS NULL;                      -- 0
-- ORDEM: depende da 376. ANTES ou depois do deploy do app (sem a coluna o cron simplesmente não expira nada). Idempotente. lock_timeout de 5 s: se a
--   tabela estiver ocupada, aborta limpo; rode de novo.
--
-- ROLLBACK (testado em PGlite por src/lib/inbox/reservation-expiry.sql.test.ts, que executa exatamente as linhas abaixo):
-- ROLLBACK-INICIO
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP TRIGGER IF EXISTS trg_sync_mention_requested_at_ins ON wacrm.conversations;
--   DROP TRIGGER IF EXISTS trg_sync_mention_requested_at_upd ON wacrm.conversations;
--   DROP FUNCTION IF EXISTS wacrm.sync_mention_requested_at();
--   ALTER TABLE wacrm.conversations DROP COLUMN IF EXISTS requested_at;
--   DELETE FROM wacrm.schema_migrations WHERE version = '384_reserva_requested_at';
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ROLLBACK-FIM
-- (Sem a coluna o app deixa de expirar reservas, que voltam a esperar o operador, como antes da 384; nenhuma reserva é perdida.)
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('wacrm.conversations') IS NULL THEN
    RAISE EXCEPTION '384: falta wacrm.conversations — confira o schema vivo';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'conversations'
        AND column_name IN ('requested_agent_id', 'assigned_agent_id', 'status')) <> 3 THEN
    RAISE EXCEPTION '384: faltam colunas em wacrm.conversations (requested_agent_id é da migration 376)';
  END IF;
  IF to_regprocedure('wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '384: falta wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text) (migration 376)';
  END IF;
END $$;

ALTER TABLE wacrm.conversations ADD COLUMN IF NOT EXISTS requested_at timestamptz;

-- Reservas que já existem: o relógio começa agora. (Antes de criar os triggers, que ignorariam a escrita direta da coluna.)
UPDATE wacrm.conversations SET requested_at = now() WHERE requested_agent_id IS NOT NULL AND requested_at IS NULL;

CREATE OR REPLACE FUNCTION wacrm.sync_mention_requested_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.requested_agent_id IS NULL THEN
    NEW.requested_at := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.requested_agent_id IS DISTINCT FROM NEW.requested_agent_id THEN
    NEW.requested_at := now();
  ELSE
    NEW.requested_at := OLD.requested_at; -- mesmo operador: o prazo não anda nem por escrita direta da coluna
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.sync_mention_requested_at() FROM PUBLIC, anon, authenticated;

-- A WHEN é avaliada com a linha já alterada pelos triggers BEFORE anteriores (trg_clear_mention_reservation da 376 limpa a reserva ao assumir/fechar):
-- por isso este trigger não depende de "UPDATE OF" (que só olharia as colunas citadas no comando).
DROP TRIGGER IF EXISTS trg_sync_mention_requested_at_ins ON wacrm.conversations;
CREATE TRIGGER trg_sync_mention_requested_at_ins
  BEFORE INSERT ON wacrm.conversations
  FOR EACH ROW WHEN (NEW.requested_agent_id IS NOT NULL OR NEW.requested_at IS NOT NULL)
  EXECUTE FUNCTION wacrm.sync_mention_requested_at();

DROP TRIGGER IF EXISTS trg_sync_mention_requested_at_upd ON wacrm.conversations;
CREATE TRIGGER trg_sync_mention_requested_at_upd
  BEFORE UPDATE ON wacrm.conversations
  FOR EACH ROW WHEN (
    NEW.requested_agent_id IS DISTINCT FROM OLD.requested_agent_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR (NEW.requested_agent_id IS NULL AND NEW.requested_at IS NOT NULL)
  )
  EXECUTE FUNCTION wacrm.sync_mention_requested_at();

DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version)
    VALUES ('384_reserva_requested_at') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
