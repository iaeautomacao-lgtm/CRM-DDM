-- ============================================================
-- 204_outbound_webhooks.sql   (PRD 15, 15.14 — webhooks de saída assinados; API-05)
--
-- PROBLEMA: o CRM só chamava o integrador em `campaign.completed` (callback_url da campanha), sem assinatura, sem segredo e com retry
-- infinito. O integrador de cobrança (ERP/Cobmais/DDM Core) fazia polling para saber de resposta, entrega, encerramento, opt-out e acordo.
--
-- O QUE FAZ:
--   1. wacrm.webhook_endpoints   — endpoints cadastráveis por conta (HTTPS), eventos assinados, segredo CIFRADO (AES-GCM no servidor).
--   2. wacrm.webhook_deliveries  — fila de entregas (outbox): pending → sending → delivered | dead. Retry exponencial 30 s · 2^n (teto
--      1 h) com jitter até 12 tentativas, depois `dead` (reenvio manual por replay). Única por (endpoint, evento): idempotente.
--   3. RPCs (só service_role): enqueue_webhook_event, claim_webhook_deliveries (FOR UPDATE SKIP LOCKED + lease), complete_webhook_delivery,
--      fail_webhook_delivery, replay_webhook_delivery.
--   4. TRIGGERS no banco (outbox transacional: pega QUALQUER origem — Meta, WAHA, webchat, API v1, fluxos, IA, importação):
--        message.received      messages INSERT de cliente
--        message.status        messages.status mudou (enviada/entregue/lida/falha)
--        conversation.closed   conversations.status → closed (com a tabulação, se houver)
--        agreement.created     conversations.outcome_tag_id → tabulação 142 "Acordo Realizado" (mesmo código de acordo-tagging.ts)
--        contact.opt_out       blacklist com motivo 'opt_out' (INSERT ou UPDATE para opt_out)
--      Cada trigger é à prova de falha (EXCEPTION → WARNING: nunca derruba a escrita original) e só trabalha se a conta tiver endpoint
--      ativo assinando aquele evento (uma consulta indexada por linha; sem endpoint, custo desprezível).
--   O app (src/lib/webhooks-out) assina com HMAC-SHA256, entrega com safeFetch (SSRF-guard) e marca o resultado; o cron
--   /api/webhooks-out/cron drena a fila. Retenção das entregas antigas está FORA desta migration (decisão de dados do dono).
--
-- PRÉ-CHECK (rodar ANTES; o schema vivo manda — blacklist não tem CREATE TABLE nas migrations):
--   SELECT to_regclass('wacrm.accounts'), to_regclass('wacrm.conversations'), to_regclass('wacrm.messages'), to_regclass('wacrm.tags');   -- não nulos
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='conversations'
--      AND column_name IN ('id','account_id','contact_id','status','outcome_tag_id');                                    -- 5 linhas
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='blacklist'
--      AND column_name IN ('account_id','telefone','motivo','bloqueado_por');                                            -- 4 linhas (se a tabela existir)
--   SELECT to_regclass('wacrm.webhook_endpoints'), to_regclass('wacrm.webhook_deliveries');                              -- NULL na 1ª vez
-- VERIFICAÇÃO (depois): SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_webhook_%' AND NOT tgisinternal ORDER BY 1;  -- 5 (ou 4 sem blacklist)
-- ORDEM: antes ou depois do deploy (sem a 204 o app responde 503 em /api/v1/webhooks e o cron não faz nada). Idempotente.
--   As tabelas são NOVAS (vazias): CREATE INDEX comum é instantâneo — não precisa de arquivo `b` com CONCURRENTLY.
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_webhook_message_received ON wacrm.messages;  DROP TRIGGER IF EXISTS trg_webhook_message_status ON wacrm.messages;
--   DROP TRIGGER IF EXISTS trg_webhook_conversation ON wacrm.conversations;
--   DO $r$ BEGIN IF to_regclass('wacrm.blacklist') IS NOT NULL THEN
--     DROP TRIGGER IF EXISTS trg_webhook_opt_out_ins ON wacrm.blacklist; DROP TRIGGER IF EXISTS trg_webhook_opt_out_upd ON wacrm.blacklist; END IF; END $r$;
--   DROP FUNCTION IF EXISTS wacrm.webhook_on_message_received(), wacrm.webhook_on_message_status(), wacrm.webhook_on_conversation(),
--     wacrm.webhook_on_opt_out(), wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb), wacrm.webhook_endpoint_listens(uuid, text),
--     wacrm.claim_webhook_deliveries(uuid, integer), wacrm.complete_webhook_delivery(uuid, uuid, integer),
--     wacrm.fail_webhook_delivery(uuid, uuid, integer, text, boolean), wacrm.replay_webhook_delivery(uuid, uuid, uuid);
--   DROP TABLE IF EXISTS wacrm.webhook_deliveries; DROP TABLE IF EXISTS wacrm.webhook_endpoints;
--   DELETE FROM wacrm.schema_migrations WHERE version = '204_outbound_webhooks';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.messages') IS NULL
     OR to_regclass('wacrm.tags') IS NULL THEN
    RAISE EXCEPTION '204: faltam wacrm.accounts/conversations/messages/tags — confira o schema vivo';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'conversations'
        AND column_name IN ('id','account_id','contact_id','status','outcome_tag_id')) <> 5 THEN
    RAISE EXCEPTION '204: wacrm.conversations precisa de id, account_id, contact_id, status e outcome_tag_id (migration 041)';
  END IF;
END $$;

-- ---- endpoints -------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.webhook_endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  url                  text NOT NULL CHECK (length(url) <= 2000 AND url ~ '^https://'),
  description          text CHECK (description IS NULL OR length(description) <= 200),
  events               text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20),
  secret_enc           text NOT NULL,                       -- AES-256-GCM (iv:ciphertext:authTag); nunca em claro, nunca devolvido depois da criação
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by_key       uuid,                                -- id da chave de API que cadastrou (sem FK: a chave pode ser revogada)
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_account_active ON wacrm.webhook_endpoints (account_id) WHERE status = 'active';

-- ---- entregas (outbox) -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),     -- = X-CRM-Delivery
  account_id      uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES wacrm.webhook_endpoints(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL,                                  -- mesmo evento = mesmo id em todos os endpoints (o receptor deduplica por ele)
  event           text NOT NULL,
  payload         jsonb NOT NULL,                                 -- envelope {id, type, created_at, account_id, data}
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'delivered', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  owner_id        uuid,
  last_status     integer,                                        -- HTTP da última tentativa (NULL = falha de rede/SSRF)
  last_error      text,                                           -- curto e SEM corpo/PII
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  dead_at         timestamptz,
  CONSTRAINT uq_webhook_delivery_endpoint_event UNIQUE (endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON wacrm.webhook_deliveries (next_attempt_at) WHERE state IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON wacrm.webhook_deliveries (endpoint_id, created_at DESC, id DESC);

-- Fechadas: RLS ligada, sem policy. Só service_role (rotas da API v1 e cron) e as funções SECURITY DEFINER abaixo.
ALTER TABLE wacrm.webhook_endpoints  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.webhook_endpoints, wacrm.webhook_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.webhook_endpoints, wacrm.webhook_deliveries TO service_role;

-- ---- RPCs --------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.webhook_endpoint_listens(p_account uuid, p_event text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = wacrm, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM wacrm.webhook_endpoints e
     WHERE e.account_id = p_account AND e.status = 'active' AND p_event = ANY (e.events)
  )
$$;

-- Fan-out: uma entrega por endpoint ativo que assina o evento. Idempotente por (endpoint, event_id). Devolve quantas criou.
CREATE OR REPLACE FUNCTION wacrm.enqueue_webhook_event(p_account uuid, p_event text, p_event_id uuid, p_data jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_n integer;
  v_envelope jsonb;
BEGIN
  IF p_account IS NULL OR p_event IS NULL OR p_event_id IS NULL THEN RETURN 0; END IF;
  v_envelope := jsonb_build_object(
    'id', p_event_id, 'type', p_event,
    'created_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'account_id', p_account, 'data', coalesce(p_data, '{}'::jsonb));
  INSERT INTO wacrm.webhook_deliveries (account_id, endpoint_id, event_id, event, payload)
    SELECT e.account_id, e.id, p_event_id, p_event, v_envelope
      FROM wacrm.webhook_endpoints e
     WHERE e.account_id = p_account AND e.status = 'active' AND p_event = ANY (e.events)
  ON CONFLICT (endpoint_id, event_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Reserva entregas devidas (lease de 120 s). Linha `sending` com lease vencido volta à fila; sem tentativas restantes vira `dead`.
CREATE OR REPLACE FUNCTION wacrm.claim_webhook_deliveries(p_owner uuid, p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, account_id uuid, endpoint_id uuid, event text, payload jsonb, attempts integer, url text, secret_enc text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
#variable_conflict use_column
BEGIN
  UPDATE wacrm.webhook_deliveries d
     SET state = 'dead', dead_at = now(), owner_id = NULL, lease_until = NULL,
         last_error = coalesce(d.last_error, 'Lease vencido sem tentativas restantes')
   WHERE d.state = 'sending' AND d.lease_until < now() AND d.attempts >= 12;

  RETURN QUERY
  WITH due AS (
    SELECT d.id AS did
      FROM wacrm.webhook_deliveries d
      JOIN wacrm.webhook_endpoints e ON e.id = d.endpoint_id
     WHERE e.status = 'active'
       AND ((d.state = 'pending' AND d.next_attempt_at <= now()) OR (d.state = 'sending' AND d.lease_until < now()))
     ORDER BY d.next_attempt_at
     LIMIT greatest(1, least(coalesce(p_limit, 20), 200))
       FOR UPDATE OF d SKIP LOCKED
  ), claimed AS (
    UPDATE wacrm.webhook_deliveries d
       SET state = 'sending', owner_id = p_owner, lease_until = now() + interval '120 seconds', attempts = d.attempts + 1
      FROM due WHERE d.id = due.did
    RETURNING d.id, d.account_id, d.endpoint_id, d.event, d.payload, d.attempts
  )
  SELECT c.id, c.account_id, c.endpoint_id, c.event, c.payload, c.attempts, e.url, e.secret_enc
    FROM claimed c JOIN wacrm.webhook_endpoints e ON e.id = c.endpoint_id;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.complete_webhook_delivery(p_id uuid, p_owner uuid, p_http integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_endpoint uuid;
BEGIN
  UPDATE wacrm.webhook_deliveries d
     SET state = 'delivered', delivered_at = now(), owner_id = NULL, lease_until = NULL, last_status = p_http, last_error = NULL
   WHERE d.id = p_id AND d.owner_id = p_owner AND d.state = 'sending'
  RETURNING d.endpoint_id INTO v_endpoint;
  IF v_endpoint IS NULL THEN RETURN false; END IF;
  UPDATE wacrm.webhook_endpoints SET consecutive_failures = 0, last_success_at = now() WHERE id = v_endpoint;
  RETURN true;
END;
$$;

-- Falha: backoff 30 s · 2^(tentativa-1), teto 1 h, jitter ±10 %; `p_final` (erro que não adianta repetir, ex.: SSRF bloqueou) ou 12
-- tentativas esgotadas → `dead`. Devolve o novo estado ('pending'|'dead') ou NULL se o lease não é mais deste dono.
CREATE OR REPLACE FUNCTION wacrm.fail_webhook_delivery(p_id uuid, p_owner uuid, p_http integer, p_error text, p_final boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_row wacrm.webhook_deliveries%ROWTYPE;
  v_state text;
BEGIN
  SELECT * INTO v_row FROM wacrm.webhook_deliveries WHERE id = p_id AND owner_id = p_owner AND state = 'sending' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_state := CASE WHEN p_final OR v_row.attempts >= 12 THEN 'dead' ELSE 'pending' END;
  UPDATE wacrm.webhook_deliveries d
     SET state = v_state, owner_id = NULL, lease_until = NULL, last_status = p_http, last_error = left(p_error, 300),
         dead_at = CASE WHEN v_state = 'dead' THEN now() END,
         next_attempt_at = CASE WHEN v_state = 'pending'
           THEN now() + make_interval(secs => least(3600, 30 * power(2, greatest(v_row.attempts - 1, 0))) * (0.9 + random() * 0.2))
           ELSE d.next_attempt_at END
   WHERE d.id = p_id;
  UPDATE wacrm.webhook_endpoints SET consecutive_failures = consecutive_failures + 1, last_failure_at = now() WHERE id = v_row.endpoint_id;
  RETURN v_state;
END;
$$;

-- Reenvio manual de uma entrega `dead` (zera as tentativas). Escopado por conta e endpoint.
CREATE OR REPLACE FUNCTION wacrm.replay_webhook_delivery(p_account uuid, p_endpoint uuid, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE wacrm.webhook_deliveries d
     SET state = 'pending', attempts = 0, next_attempt_at = now(), dead_at = NULL, owner_id = NULL, lease_until = NULL, last_error = NULL
   WHERE d.id = p_id AND d.account_id = p_account AND d.endpoint_id = p_endpoint AND d.state = 'dead'
  RETURNING d.id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.webhook_endpoint_listens(uuid, text), wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb),
  wacrm.claim_webhook_deliveries(uuid, integer), wacrm.complete_webhook_delivery(uuid, uuid, integer),
  wacrm.fail_webhook_delivery(uuid, uuid, integer, text, boolean), wacrm.replay_webhook_delivery(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb), wacrm.claim_webhook_deliveries(uuid, integer),
  wacrm.complete_webhook_delivery(uuid, uuid, integer), wacrm.fail_webhook_delivery(uuid, uuid, integer, text, boolean),
  wacrm.replay_webhook_delivery(uuid, uuid, uuid) TO service_role;

-- ---- triggers (outbox transacional) --------------------------------------------------------------------------------------
-- message.received: mensagem de cliente. event_id determinístico (a mesma mensagem nunca gera dois eventos).
CREATE OR REPLACE FUNCTION wacrm.webhook_on_message_received()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_account uuid; v_contact uuid; v_phone text;
BEGIN
  SELECT c.account_id, c.contact_id INTO v_account, v_contact FROM wacrm.conversations c WHERE c.id = NEW.conversation_id;
  IF v_account IS NULL OR NOT wacrm.webhook_endpoint_listens(v_account, 'message.received') THEN RETURN NULL; END IF;
  SELECT ct.phone INTO v_phone FROM wacrm.contacts ct WHERE ct.id = v_contact;
  PERFORM wacrm.enqueue_webhook_event(v_account, 'message.received', md5('message.received:' || NEW.id::text)::uuid, jsonb_build_object(
    'message_id', NEW.id, 'provider_message_id', NEW.message_id, 'conversation_id', NEW.conversation_id, 'contact_id', v_contact,
    'phone', v_phone, 'content_type', NEW.content_type, 'text', NEW.content_text, 'has_media', NEW.media_url IS NOT NULL,
    'received_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_message_received falhou: %', SQLERRM;  -- nunca derruba a escrita original
  RETURN NULL;
END;
$$;

-- message.status: mudança de status de mensagem enviada (sent/delivered/read/failed).
CREATE OR REPLACE FUNCTION wacrm.webhook_on_message_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_account uuid; v_contact uuid;
BEGIN
  SELECT c.account_id, c.contact_id INTO v_account, v_contact FROM wacrm.conversations c WHERE c.id = NEW.conversation_id;
  IF v_account IS NULL OR NOT wacrm.webhook_endpoint_listens(v_account, 'message.status') THEN RETURN NULL; END IF;
  PERFORM wacrm.enqueue_webhook_event(v_account, 'message.status', md5('message.status:' || NEW.id::text || ':' || NEW.status)::uuid, jsonb_build_object(
    'message_id', NEW.id, 'provider_message_id', NEW.message_id, 'conversation_id', NEW.conversation_id, 'contact_id', v_contact,
    'status', NEW.status, 'previous_status', OLD.status));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_message_status falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

-- conversation.closed e agreement.created (tabulação 142 "Acordo Realizado", o mesmo código de src/lib/ai/acordo-tagging.ts).
CREATE OR REPLACE FUNCTION wacrm.webhook_on_conversation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_tag_id uuid;
  v_tag_name text;
  v_tag_code integer;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NULL; END IF;
  IF NEW.outcome_tag_id IS NOT NULL THEN
    SELECT t.id, t.name, t.codigo_tabulacao INTO v_tag_id, v_tag_name, v_tag_code FROM wacrm.tags t WHERE t.id = NEW.outcome_tag_id;
  END IF;

  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed'
     AND wacrm.webhook_endpoint_listens(NEW.account_id, 'conversation.closed') THEN
    PERFORM wacrm.enqueue_webhook_event(NEW.account_id, 'conversation.closed', gen_random_uuid(), jsonb_build_object(
      'conversation_id', NEW.id, 'contact_id', NEW.contact_id,
      'outcome', CASE WHEN v_tag_id IS NULL THEN NULL
                      ELSE jsonb_build_object('tag_id', v_tag_id, 'name', v_tag_name, 'code', v_tag_code) END));
  END IF;

  IF NEW.outcome_tag_id IS NOT NULL AND NEW.outcome_tag_id IS DISTINCT FROM OLD.outcome_tag_id
     AND v_tag_code = 142 AND wacrm.webhook_endpoint_listens(NEW.account_id, 'agreement.created') THEN
    PERFORM wacrm.enqueue_webhook_event(NEW.account_id, 'agreement.created',
      md5('agreement.created:' || NEW.id::text || ':' || NEW.outcome_tag_id::text || ':' || clock_timestamp()::text)::uuid,
      jsonb_build_object('conversation_id', NEW.id, 'contact_id', NEW.contact_id, 'tabulation_code', 142, 'tabulation', v_tag_name));
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_conversation falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

-- contact.opt_out: blacklist com motivo 'opt_out' (a IA grava com upsert por telefone: cobre INSERT e UPDATE para opt_out).
CREATE OR REPLACE FUNCTION wacrm.webhook_on_opt_out()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_account uuid := (to_jsonb(NEW) ->> 'account_id')::uuid;
  v_phone text := regexp_replace(coalesce(to_jsonb(NEW) ->> 'telefone', ''), '\D', '', 'g');
BEGIN
  IF v_account IS NULL OR v_phone = '' OR NOT wacrm.webhook_endpoint_listens(v_account, 'contact.opt_out') THEN RETURN NULL; END IF;
  PERFORM wacrm.enqueue_webhook_event(v_account, 'contact.opt_out',
    md5('contact.opt_out:' || v_account::text || ':' || v_phone || ':' || clock_timestamp()::text)::uuid,
    jsonb_build_object('phone', v_phone, 'reason', v_row ->> 'motivo', 'source', v_row ->> 'bloqueado_por'));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_opt_out falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.webhook_on_message_received(), wacrm.webhook_on_message_status(), wacrm.webhook_on_conversation(),
  wacrm.webhook_on_opt_out() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_webhook_message_received ON wacrm.messages;
CREATE TRIGGER trg_webhook_message_received AFTER INSERT ON wacrm.messages
  FOR EACH ROW WHEN (NEW.sender_type = 'customer') EXECUTE FUNCTION wacrm.webhook_on_message_received();
DROP TRIGGER IF EXISTS trg_webhook_message_status ON wacrm.messages;
CREATE TRIGGER trg_webhook_message_status AFTER UPDATE OF status ON wacrm.messages
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.sender_type <> 'customer') EXECUTE FUNCTION wacrm.webhook_on_message_status();
DROP TRIGGER IF EXISTS trg_webhook_conversation ON wacrm.conversations;
CREATE TRIGGER trg_webhook_conversation AFTER UPDATE OF status, outcome_tag_id ON wacrm.conversations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.outcome_tag_id IS DISTINCT FROM NEW.outcome_tag_id)
  EXECUTE FUNCTION wacrm.webhook_on_conversation();

DO $$
BEGIN
  IF to_regclass('wacrm.blacklist') IS NULL THEN
    RAISE NOTICE '204: wacrm.blacklist não existe, trigger de opt-out ignorado';
    RETURN;
  END IF;
  EXECUTE 'DROP TRIGGER IF EXISTS trg_webhook_opt_out_ins ON wacrm.blacklist';
  EXECUTE 'CREATE TRIGGER trg_webhook_opt_out_ins AFTER INSERT ON wacrm.blacklist FOR EACH ROW WHEN (NEW.motivo = ''opt_out'') EXECUTE FUNCTION wacrm.webhook_on_opt_out()';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_webhook_opt_out_upd ON wacrm.blacklist';
  EXECUTE 'CREATE TRIGGER trg_webhook_opt_out_upd AFTER UPDATE ON wacrm.blacklist FOR EACH ROW WHEN (NEW.motivo = ''opt_out'' AND OLD.motivo IS DISTINCT FROM ''opt_out'') EXECUTE FUNCTION wacrm.webhook_on_opt_out()';
END $$;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('204_outbound_webhooks') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
