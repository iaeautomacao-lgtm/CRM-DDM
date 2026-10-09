-- ============================================================
-- 298_web_push.sql   (TASK36 item 3 / PRD 23 item 14 — notificação push do navegador "Nova conversa em espera")
--
-- Decisão do dono (09/10): fazer. Chaves VAPID geradas pela PLATAFORMA (self-service, nada no .env), uma por conta, privada CIFRADA
-- (AES-256-GCM da plataforma), em tabela FECHADA (RLS sem policy, só service role) — mesmo padrão das chaves de Flows (291).
--
--   wacrm.push_vapid_keys     (account_id PK, public_key base64url [ponto P-256 não comprimido], private_key_enc iv:ct:tag)
--   wacrm.push_subscriptions  uma por navegador/dispositivo (endpoint único). RLS: cada usuário vê e apaga SÓ as suas; a escrita é
--                             do servidor (valida o endpoint contra a lista de serviços de push antes de gravar).
--   wacrm.push_outbox         fila de avisos: um trigger em conversations insere uma linha quando a conversa ENTRA em 'pending'
--                             (em espera). O envio é assíncrono (cron / after() do webhook) e NUNCA bloqueia o webhook de entrada.
--   wacrm.claim_push_outbox(p_limit) — reserva linhas (FOR UPDATE SKIP LOCKED) marcando processed_at: entrega "no máximo uma vez"
--                             (erro de envio só é registrado, não reenviado em loop).
--
-- O trigger só insere (uma linha pequena, na mesma transação da conversa) quando o status MUDA para 'pending' e não há aviso pendente da
-- mesma conversa; não chama rede. Sem as tabelas, o app ignora (rotas respondem 503 e o disparo é no-op).
--
-- PRÉ-CHECK: SELECT to_regclass('wacrm.conversations'), to_regclass('wacrm.accounts');   -- não nulos
--            SELECT to_regclass('wacrm.push_subscriptions');                               -- NULL na 1ª vez
-- VERIFICAÇÃO: SELECT tgname FROM pg_trigger WHERE tgname = 'trg_push_outbox_conversation_pending';   -- 2 linhas (ins/upd)
-- ORDEM: antes ou depois do deploy. Idempotente.
-- ROLLBACK:  DROP TRIGGER IF EXISTS trg_push_outbox_conversation_pending_ins ON wacrm.conversations;
--            DROP TRIGGER IF EXISTS trg_push_outbox_conversation_pending_upd ON wacrm.conversations;
--            DROP FUNCTION IF EXISTS wacrm.push_outbox_conversation_pending(); DROP FUNCTION IF EXISTS wacrm.claim_push_outbox(integer);
--            DROP TABLE IF EXISTS wacrm.push_outbox, wacrm.push_subscriptions, wacrm.push_vapid_keys;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '298: faltam wacrm.conversations/accounts — confira o schema vivo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.push_vapid_keys (
  account_id      uuid PRIMARY KEY REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  public_key      text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{80,100}$'),
  private_key_enc text NOT NULL CHECK (private_key_enc ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$'),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wacrm.push_vapid_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.push_vapid_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.push_vapid_keys TO service_role;

CREATE TABLE IF NOT EXISTS wacrm.push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE CHECK (char_length(endpoint) BETWEEN 20 AND 2048),
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON wacrm.push_subscriptions (account_id, user_id);

ALTER TABLE wacrm.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON wacrm.push_subscriptions TO authenticated;
GRANT ALL ON wacrm.push_subscriptions TO service_role;
DROP POLICY IF EXISTS push_subscriptions_select_own ON wacrm.push_subscriptions;
CREATE POLICY push_subscriptions_select_own ON wacrm.push_subscriptions FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS push_subscriptions_delete_own ON wacrm.push_subscriptions;
CREATE POLICY push_subscriptions_delete_own ON wacrm.push_subscriptions FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS wacrm.push_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  conversation_id uuid NOT NULL,
  team_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at    timestamptz
);
-- Fila (só pendentes) e dedupe "um aviso pendente por conversa".
CREATE INDEX IF NOT EXISTS idx_push_outbox_pending ON wacrm.push_outbox (created_at) WHERE processed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_outbox_pending_conversation ON wacrm.push_outbox (conversation_id) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_push_outbox_processed ON wacrm.push_outbox (processed_at) WHERE processed_at IS NOT NULL;
ALTER TABLE wacrm.push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.push_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.push_outbox TO service_role;

CREATE OR REPLACE FUNCTION wacrm.push_outbox_conversation_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Nunca derruba a gravação da conversa por causa do aviso.
  BEGIN
    INSERT INTO wacrm.push_outbox (account_id, conversation_id, team_id)
    VALUES (NEW.account_id, NEW.id, NEW.team_id)
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.push_outbox_conversation_pending() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_push_outbox_conversation_pending_ins ON wacrm.conversations;
CREATE TRIGGER trg_push_outbox_conversation_pending_ins
  AFTER INSERT ON wacrm.conversations
  FOR EACH ROW WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION wacrm.push_outbox_conversation_pending();
DROP TRIGGER IF EXISTS trg_push_outbox_conversation_pending_upd ON wacrm.conversations;
CREATE TRIGGER trg_push_outbox_conversation_pending_upd
  AFTER UPDATE OF status ON wacrm.conversations
  FOR EACH ROW WHEN (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending')
  EXECUTE FUNCTION wacrm.push_outbox_conversation_pending();

CREATE OR REPLACE FUNCTION wacrm.claim_push_outbox(p_limit integer DEFAULT 50)
RETURNS SETOF wacrm.push_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Limpeza barata de avisos antigos já processados (1 dia).
  DELETE FROM wacrm.push_outbox WHERE processed_at < clock_timestamp() - interval '1 day';
  RETURN QUERY
  WITH picked AS (
    SELECT o.id FROM wacrm.push_outbox o
    WHERE o.processed_at IS NULL
    ORDER BY o.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE wacrm.push_outbox u SET processed_at = clock_timestamp()
  FROM picked p WHERE u.id = p.id
  RETURNING u.*;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.claim_push_outbox(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_push_outbox(integer) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('298_web_push') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
