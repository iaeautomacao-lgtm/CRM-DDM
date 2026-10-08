-- ============================================================
-- 201_webhook_message_inbox.sql
--
-- Inbox DURÁVEL de MENSAGENS recebidas da Meta (PRD 15 — WH-01/WH-02). Mesmo modelo do inbox de status (185).
--
-- Problema: a mensagem do cliente só era gravada DEPOIS do 200, dentro de after() (whatsapp/webhook/route.ts).
-- Reinício/deploy/OOM/erro do banco entre o 200 e o insert = mensagem perdida para sempre (a Meta recebeu 200 e
-- não reenvia); insert com erro ≠ 23505 só fazia console.error.
--
-- O que esta migration faz:
--  1) wacrm.webhook_message_inbox — fila durável. UNIQUE (provider, channel_id, message_id): a Meta reenviar o
--     mesmo wamid é absorvido (ON CONFLICT DO NOTHING). Guarda o mínimo para reprocessar (mensagem + contato +
--     phone_number_id; NUNCA token — o drenador relê o canal). Estados: pending → processing → done | dead;
--     shadow / shadow_missing são do modo de validação (a mensagem foi processada pelo caminho antigo e o inbox
--     só compara). Retenção: done > 3 dias e dead/shadow_* > 14 dias são apagadas (5.000 por vez).
--  2) wacrm.ingest_message_events(jsonb, text) — grava o lote ANTES do 200 (uma chamada por POST) e devolve
--     os ids novos. O app responde 500 se falhar (modo on), para a Meta reenviar.
--  3) wacrm.claim_message_inbox(owner, limit, lease, ids) — reserva (FOR UPDATE SKIP LOCKED) a CABEÇA de cada
--     conversa (conv_key): mensagens da mesma conversa saem em ordem (event_ts, id) e nunca em paralelo; vários
--     drenadores não colidem. Lease expirado volta à fila (processo caiu no meio).
--  4) wacrm.complete_message_inbox / fail_message_inbox — conclui, ou aplica backoff 30 s × 2^(tentativas-1)
--     (teto 15 min); após 8 tentativas → dead.
--  5) wacrm.try_claim_message_drain(ms) — "vez" de drenar ~1×/s no cluster (cron_locks, como a 185).
--  6) wacrm.shadow_reconcile_message_inbox(idade, limite) — modo shadow: marca done se a linha de messages já
--     existe (caminho antigo processou), senão shadow_missing (= teria sido perdida). NÃO reprocessa nada.
--  7) wacrm.message_inbox_stats() — profundidade por estado, idade do pending mais antigo, dead.
--
-- COMPATIBILIDADE: o app detecta a ausência destas funções (PGRST202/42883) e cai no caminho antigo (inline,
-- depois do 200). Pode ser aplicada antes OU depois do deploy; a durabilidade só vale depois dela.
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.webhook_message_inbox');        -- NULL antes
--   SELECT to_regclass('wacrm.cron_locks');                   -- não nulo (185/184)
--   SELECT to_regclass('wacrm.messages');                     -- não nulo
--
-- ROLLBACK: DROP TABLE wacrm.webhook_message_inbox CASCADE; DROP FUNCTION wacrm.ingest_message_events(jsonb, text),
--   wacrm.claim_message_inbox(text, integer, integer, bigint[]), wacrm.complete_message_inbox(bigint, text),
--   wacrm.fail_message_inbox(bigint, text, integer), wacrm.try_claim_message_drain(integer),
--   wacrm.shadow_reconcile_message_inbox(integer, integer), wacrm.message_inbox_stats();
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.cron_locks') IS NULL OR to_regclass('wacrm.messages') IS NULL THEN
    RAISE EXCEPTION '201: aplique as migrations de cron_locks (184/185) e de messages antes';
  END IF;
END $$;

-- ---------- 1) fila durável ----------
CREATE TABLE IF NOT EXISTS wacrm.webhook_message_inbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        text        NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta', 'waha', 'social', 'webchat')),
  account_id      uuid        NOT NULL,
  channel_id      uuid        NOT NULL,   -- canal cujo app_secret validou o HMAC (nunca vem do corpo)
  message_id      text        NOT NULL,   -- wamid
  conv_key        text        NOT NULL,   -- channel_id || ':' || remetente (ordem por conversa)
  event_ts        timestamptz NOT NULL,   -- horário do provedor
  payload         jsonb       NOT NULL,   -- { message, contact, phone_number_id } — SEM token
  state           text        NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'processing', 'done', 'dead', 'shadow', 'shadow_missing')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until     timestamptz,
  owner_id        text,
  last_error      text,
  outcome         text,                   -- processed | duplicate | shadow_match | shadow_na | …
  received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at    timestamptz,
  CONSTRAINT webhook_message_inbox_dedupe UNIQUE (provider, channel_id, message_id)
);

-- Fila (drenagem) e cabeça por conversa.
CREATE INDEX IF NOT EXISTS idx_wmi_queue
  ON wacrm.webhook_message_inbox (conv_key, event_ts, id) WHERE state IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_wmi_due
  ON wacrm.webhook_message_inbox (next_attempt_at) WHERE state IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_wmi_shadow
  ON wacrm.webhook_message_inbox (received_at) WHERE state = 'shadow';
CREATE INDEX IF NOT EXISTS idx_wmi_retention
  ON wacrm.webhook_message_inbox (processed_at) WHERE state IN ('done', 'dead', 'shadow_missing');

ALTER TABLE wacrm.webhook_message_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.webhook_message_inbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.webhook_message_inbox TO service_role;

-- ---------- 2) ingestão (antes do 200) ----------
-- p_state: 'pending' (modo on: o drenador processa) ou 'shadow' (modo shadow: o caminho antigo processa).
CREATE OR REPLACE FUNCTION wacrm.ingest_message_events(p_events jsonb, p_state text DEFAULT 'pending')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids bigint[];
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN jsonb_build_object('inserted', 0, 'ids', '[]'::jsonb);
  END IF;
  IF p_state NOT IN ('pending', 'shadow') THEN
    RAISE EXCEPTION 'ingest_message_events: estado inválido %', p_state;
  END IF;

  WITH ins AS (
    INSERT INTO wacrm.webhook_message_inbox(provider, account_id, channel_id, message_id, conv_key, event_ts, payload, state)
    SELECT COALESCE(e.provider, 'meta'), e.account_id, e.channel_id, e.message_id,
           e.channel_id::text || ':' || COALESCE(NULLIF(e.sender, ''), '?'),
           COALESCE(to_timestamp(e.ts), clock_timestamp()),
           e.payload, p_state
    FROM jsonb_to_recordset(p_events) AS e(
      provider text, account_id uuid, channel_id uuid, message_id text, sender text, ts double precision, payload jsonb
    )
    WHERE e.message_id IS NOT NULL AND e.message_id <> ''
      AND e.account_id IS NOT NULL AND e.channel_id IS NOT NULL AND e.payload IS NOT NULL
    ON CONFLICT ON CONSTRAINT webhook_message_inbox_dedupe DO NOTHING
    RETURNING id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::bigint[]) INTO v_ids FROM ins;

  RETURN jsonb_build_object('inserted', cardinality(v_ids), 'ids', to_jsonb(v_ids));
END;
$$;

-- ---------- 3) claim ----------
-- p_ids (opcional): reserva só essas linhas (o after() do webhook processa as PRÓPRIAS mensagens sem esperar a vez).
CREATE OR REPLACE FUNCTION wacrm.claim_message_inbox(
  p_owner text,
  p_limit integer DEFAULT 20,
  p_lease_seconds integer DEFAULT 120,
  p_ids bigint[] DEFAULT NULL
)
RETURNS SETOF wacrm.webhook_message_inbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH heads AS (
    -- Cabeça de cada conversa: a mensagem mais antiga ainda não concluída (inclusive em backoff ou em
    -- processamento — a seguinte espera, para manter a ordem).
    SELECT DISTINCT ON (i.conv_key) i.id
    FROM wacrm.webhook_message_inbox i
    WHERE i.state IN ('pending', 'processing')
    ORDER BY i.conv_key, i.event_ts, i.id
  ),
  picked AS (
    SELECT i.id
    FROM wacrm.webhook_message_inbox i
    JOIN heads h ON h.id = i.id
    WHERE (p_ids IS NULL OR i.id = ANY (p_ids))
      AND (
        (i.state = 'pending' AND i.next_attempt_at <= clock_timestamp())
        OR (i.state = 'processing' AND i.lease_until < clock_timestamp())
      )
    ORDER BY i.received_at, i.id
    LIMIT GREATEST(COALESCE(p_limit, 20), 1)
    FOR UPDATE OF i SKIP LOCKED
  )
  UPDATE wacrm.webhook_message_inbox u
  SET state = 'processing',
      attempts = u.attempts + 1,
      owner_id = p_owner,
      lease_until = clock_timestamp() + pg_catalog.make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 10)),
      last_error = CASE WHEN u.state = 'processing' THEN COALESCE(u.last_error, 'lease expirado (processo caiu no meio)') ELSE u.last_error END
  FROM picked p
  WHERE u.id = p.id
  RETURNING u.*;
END;
$$;

-- ---------- 4) concluir / falhar ----------
CREATE OR REPLACE FUNCTION wacrm.complete_message_inbox(p_id bigint, p_outcome text DEFAULT 'processed')
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE wacrm.webhook_message_inbox
  SET state = 'done', outcome = p_outcome, processed_at = clock_timestamp(),
      lease_until = NULL, owner_id = NULL, last_error = NULL
  WHERE id = p_id;
$$;

-- Devolve o estado novo ('pending' com backoff, ou 'dead' após p_max_attempts).
CREATE OR REPLACE FUNCTION wacrm.fail_message_inbox(p_id bigint, p_error text, p_max_attempts integer DEFAULT 8)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  UPDATE wacrm.webhook_message_inbox
  SET state = CASE WHEN attempts >= GREATEST(COALESCE(p_max_attempts, 8), 1) THEN 'dead' ELSE 'pending' END,
      next_attempt_at = clock_timestamp()
        + pg_catalog.make_interval(secs => LEAST(30 * power(2, GREATEST(attempts - 1, 0)), 900)::integer),
      processed_at = CASE WHEN attempts >= GREATEST(COALESCE(p_max_attempts, 8), 1) THEN clock_timestamp() ELSE NULL END,
      outcome = CASE WHEN attempts >= GREATEST(COALESCE(p_max_attempts, 8), 1) THEN 'dead' ELSE outcome END,
      lease_until = NULL, owner_id = NULL,
      last_error = left(COALESCE(p_error, 'erro desconhecido'), 500)
  WHERE id = p_id AND state = 'processing'
  RETURNING state INTO v_state;
  RETURN v_state;
END;
$$;

-- ---------- 5) vez de drenar (~1×/s no cluster) ----------
CREATE OR REPLACE FUNCTION wacrm.try_claim_message_drain(p_interval_ms integer DEFAULT 1000)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  INSERT INTO wacrm.cron_locks (name, owner_id, acquired_at, expires_at)
  VALUES (
    'webhook_message_drain', 'drain', clock_timestamp(),
    clock_timestamp() + pg_catalog.make_interval(secs => GREATEST(COALESCE(p_interval_ms, 1000), 100) / 1000.0)
  )
  ON CONFLICT (name) DO UPDATE
  SET owner_id = 'drain',
      acquired_at = EXCLUDED.acquired_at,
      expires_at = EXCLUDED.expires_at
  WHERE wacrm.cron_locks.expires_at <= clock_timestamp()
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

-- ---------- 6) modo shadow: compara, não reprocessa ----------
CREATE OR REPLACE FUNCTION wacrm.shadow_reconcile_message_inbox(p_min_age_seconds integer DEFAULT 30, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids     bigint[];
  v_matched integer := 0;
  v_na      integer := 0;
  v_missing integer := 0;
BEGIN
  SELECT array_agg(s.id) INTO v_ids
  FROM (
    SELECT i.id FROM wacrm.webhook_message_inbox i
    WHERE i.state = 'shadow'
      AND i.received_at < clock_timestamp() - pg_catalog.make_interval(secs => GREATEST(COALESCE(p_min_age_seconds, 30), 0))
    ORDER BY i.id
    LIMIT GREATEST(COALESCE(p_limit, 500), 1)
    FOR UPDATE SKIP LOCKED
  ) s;

  IF v_ids IS NULL THEN
    -- Ocioso: poda (done > 3 dias; dead/shadow_missing > 14 dias).
    DELETE FROM wacrm.webhook_message_inbox
    WHERE id IN (
      SELECT d.id FROM wacrm.webhook_message_inbox d
      WHERE (d.state = 'done' AND d.processed_at < clock_timestamp() - interval '3 days')
         OR (d.state IN ('dead', 'shadow_missing') AND d.processed_at < clock_timestamp() - interval '14 days')
      LIMIT 5000
    );
    RETURN jsonb_build_object('matched', 0, 'na', 0, 'missing', 0);
  END IF;

  -- Reação não vira linha em messages (só message_reactions): não há o que comparar.
  WITH na AS (
    UPDATE wacrm.webhook_message_inbox i
    SET state = 'done', outcome = 'shadow_na', processed_at = clock_timestamp()
    WHERE i.id = ANY (v_ids) AND i.payload -> 'message' ->> 'type' = 'reaction'
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_na FROM na;

  WITH ok AS (
    UPDATE wacrm.webhook_message_inbox i
    SET state = 'done', outcome = 'shadow_match', processed_at = clock_timestamp()
    WHERE i.id = ANY (v_ids) AND i.state = 'shadow'
      AND EXISTS (SELECT 1 FROM wacrm.messages m WHERE m.message_id = i.message_id)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_matched FROM ok;

  WITH miss AS (
    UPDATE wacrm.webhook_message_inbox i
    SET state = 'shadow_missing', outcome = 'shadow_missing', processed_at = clock_timestamp(),
        last_error = 'mensagem não encontrada em messages após o caminho antigo'
    WHERE i.id = ANY (v_ids) AND i.state = 'shadow'
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_missing FROM miss;

  RETURN jsonb_build_object('matched', v_matched, 'na', v_na, 'missing', v_missing);
END;
$$;

-- ---------- 7) estatísticas ----------
CREATE OR REPLACE FUNCTION wacrm.message_inbox_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'by_state', COALESCE((SELECT jsonb_object_agg(state, n) FROM (
        SELECT state, count(*) AS n FROM wacrm.webhook_message_inbox GROUP BY state) s), '{}'::jsonb),
    'oldest_pending_seconds', (SELECT EXTRACT(EPOCH FROM clock_timestamp() - min(received_at))::integer
        FROM wacrm.webhook_message_inbox WHERE state IN ('pending', 'processing')),
    'dead', (SELECT count(*) FROM wacrm.webhook_message_inbox WHERE state = 'dead'),
    'shadow_missing', (SELECT count(*) FROM wacrm.webhook_message_inbox WHERE state = 'shadow_missing'),
    'avg_attempts_open', (SELECT round(avg(attempts), 2) FROM wacrm.webhook_message_inbox WHERE state IN ('pending', 'processing'))
  );
$$;

-- ---------- grants ----------
REVOKE ALL ON FUNCTION wacrm.ingest_message_events(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.ingest_message_events(jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION wacrm.claim_message_inbox(text, integer, integer, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_message_inbox(text, integer, integer, bigint[]) TO service_role;
REVOKE ALL ON FUNCTION wacrm.complete_message_inbox(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.complete_message_inbox(bigint, text) TO service_role;
REVOKE ALL ON FUNCTION wacrm.fail_message_inbox(bigint, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.fail_message_inbox(bigint, text, integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.try_claim_message_drain(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.try_claim_message_drain(integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.shadow_reconcile_message_inbox(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.shadow_reconcile_message_inbox(integer, integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.message_inbox_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.message_inbox_stats() TO service_role;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('201_webhook_message_inbox') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
