
BEGIN;

-- ============================================================
-- Production schema reconciliation
-- Legacy migrations 118-125/132 were never registered/applied as a
-- coherent set in this project, while 126-131 are already present.
-- This migration creates only the missing final-state objects and
-- hardens the internal RPC surface expected by current main.
-- ============================================================

-- ---------- Messages account scope (required by current AI responder) ----------
ALTER TABLE wacrm.messages ADD COLUMN IF NOT EXISTS account_id uuid;

UPDATE wacrm.messages m
SET account_id = c.account_id
FROM wacrm.conversations c
WHERE c.id = m.conversation_id
  AND m.account_id IS NULL;

CREATE OR REPLACE FUNCTION wacrm.set_message_account_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT c.account_id INTO v_account
  FROM wacrm.conversations c
  WHERE c.id = NEW.conversation_id;

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Conversation not found or without account';
  END IF;

  NEW.account_id := v_account;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_message_account_id ON wacrm.messages;
CREATE TRIGGER trg_set_message_account_id
BEFORE INSERT OR UPDATE OF conversation_id ON wacrm.messages
FOR EACH ROW EXECUTE FUNCTION wacrm.set_message_account_id();

ALTER TABLE wacrm.messages ALTER COLUMN account_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_account_id_fkey'
      AND conrelid = 'wacrm.messages'::regclass
  ) THEN
    ALTER TABLE wacrm.messages
      ADD CONSTRAINT messages_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES wacrm.accounts(id) ON DELETE CASCADE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_messages_account_conversation
  ON wacrm.messages(account_id, conversation_id, created_at DESC);

-- ---------- Dispatch coordination ----------
ALTER TABLE wacrm.campaigns ADD COLUMN IF NOT EXISTS next_batch_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_dispatch_channel_in_flight
  ON wacrm.disp_message_queue(session_id) WHERE status = 'enviando';
CREATE INDEX IF NOT EXISTS idx_dispatch_campaign_in_flight
  ON wacrm.disp_message_queue(campaign_id) WHERE status = 'enviando';
CREATE INDEX IF NOT EXISTS idx_dispatch_channel_sent_at
  ON wacrm.disp_message_queue(session_id, sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_campaign_sent_at
  ON wacrm.disp_message_queue(campaign_id, sent_at) WHERE sent_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_channel_limits (
  session_id uuid PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  max_in_flight integer NOT NULL DEFAULT 4 CHECK (max_in_flight BETWEEN 1 AND 50),
  hourly_limit integer CHECK (hourly_limit > 0)
);
ALTER TABLE wacrm.dispatch_channel_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_channel_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.dispatch_channel_limits TO service_role;

CREATE OR REPLACE FUNCTION wacrm.reserve_campaign_tick(p_campaign_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE wacrm.campaigns
  SET next_batch_at = clock_timestamp()
      + make_interval(secs => GREATEST(COALESCE(batch_pause_seconds, 0), 1))
  WHERE id = p_campaign_id
    AND status = 'em_execucao'
    AND (next_batch_at IS NULL OR next_batch_at <= clock_timestamp())
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_item(p_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item wacrm.disp_message_queue%ROWTYPE;
  v_campaign wacrm.campaigns%ROWTYPE;
  v_count bigint;
  v_concurrency integer := 4;
  v_channel_limit integer;
BEGIN
  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE id = p_item_id;

  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO v_campaign
  FROM wacrm.campaigns
  WHERE id = v_item.campaign_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_campaign.status <> 'em_execucao'
     OR v_item.session_id IS NULL
  THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_item.session_id::text, 118)
  );

  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE id = p_item_id
  FOR UPDATE;

  IF v_item.status <> 'agendado'
     OR v_item.scheduled_at > clock_timestamp()
  THEN
    RETURN false;
  END IF;

  IF v_item.campaign_id IS DISTINCT FROM v_campaign.id
     OR NULLIF(v_item.waha_message_id, '') IS NOT NULL
  THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_count
  FROM wacrm.disp_message_queue
  WHERE campaign_id = v_campaign.id
    AND (
      status = 'enviando'
      OR sent_at >= clock_timestamp() - interval '1 hour'
    );

  IF COALESCE(v_campaign.limite_por_hora, 0) > 0
     AND v_count >= v_campaign.limite_por_hora
  THEN
    RETURN false;
  END IF;

  SELECT max_in_flight, hourly_limit
  INTO v_concurrency, v_channel_limit
  FROM wacrm.dispatch_channel_limits
  WHERE session_id = v_item.session_id;

  v_concurrency := COALESCE(v_concurrency, 4);

  SELECT count(*) INTO v_count
  FROM wacrm.disp_message_queue
  WHERE session_id = v_item.session_id
    AND status = 'enviando';

  IF v_count >= v_concurrency THEN RETURN false; END IF;

  IF v_channel_limit IS NOT NULL THEN
    SELECT count(*) INTO v_count
    FROM wacrm.disp_message_queue
    WHERE session_id = v_item.session_id
      AND (
        status = 'enviando'
        OR sent_at >= clock_timestamp() - interval '1 hour'
      );

    IF v_count >= v_channel_limit THEN RETURN false; END IF;
  END IF;

  UPDATE wacrm.disp_message_queue
  SET status = 'enviando',
      updated_at = clock_timestamp()
  WHERE id = p_item_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.resume_dispatch_campaign(
  p_campaign_id uuid,
  p_account_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_count integer;
BEGIN
  SELECT status INTO v_status
  FROM wacrm.campaigns
  WHERE id = p_campaign_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'pausada' THEN RETURN NULL; END IF;

  UPDATE wacrm.disp_message_queue
  SET status = 'agendado',
      scheduled_at = clock_timestamp()
  WHERE campaign_id = p_campaign_id
    AND status = 'pausado';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE wacrm.campaigns
  SET status = 'em_execucao',
      next_batch_at = NULL
  WHERE id = p_campaign_id;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.stop_dispatch_campaign(
  p_campaign_id uuid,
  p_account_id uuid,
  p_action text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_status text;
BEGIN
  IF p_action NOT IN ('pause', 'stop') THEN
    RAISE EXCEPTION 'Invalid campaign action';
  END IF;

  SELECT status INTO v_status
  FROM wacrm.campaigns
  WHERE id = p_campaign_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;
  IF p_action = 'pause' AND v_status <> 'em_execucao' THEN RETURN false; END IF;

  UPDATE wacrm.campaigns
  SET status = CASE WHEN p_action = 'pause' THEN 'pausada' ELSE 'encerrada' END
  WHERE id = p_campaign_id;

  UPDATE wacrm.disp_message_queue
  SET status = CASE WHEN p_action = 'pause' THEN 'pausado' ELSE 'cancelado' END
  WHERE campaign_id = p_campaign_id
    AND status IN ('agendado', 'pendente', 'pausado');

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.mark_queue_item_sent(
  p_item_id uuid,
  p_campaign_id uuid,
  p_contact_id uuid,
  p_session_id uuid,
  p_mensagem text,
  p_waha_message_id text,
  p_tentativas integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_item wacrm.disp_message_queue%ROWTYPE;
BEGIN
  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE id = p_item_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_item.campaign_id IS DISTINCT FROM p_campaign_id
     OR v_item.contact_id IS DISTINCT FROM p_contact_id
     OR v_item.session_id IS DISTINCT FROM p_session_id
  THEN
    RAISE EXCEPTION 'Queue item identity mismatch';
  END IF;

  IF v_item.status IN ('enviado', 'entregue', 'lido')
     AND v_item.waha_message_id = p_waha_message_id
  THEN
    RETURN;
  END IF;

  IF v_item.status <> 'enviando'
     OR NULLIF(p_waha_message_id, '') IS NULL
  THEN
    RAISE EXCEPTION 'Queue item is not awaiting confirmation';
  END IF;

  UPDATE wacrm.disp_message_queue
  SET status = 'enviado',
      sent_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      waha_message_id = p_waha_message_id,
      tentativas = p_tentativas,
      erro = NULL
  WHERE id = p_item_id;

  INSERT INTO wacrm.message_logs (
    queue_id, campaign_id, contact_id, session_id,
    direcao, mensagem, status, waha_message_id
  )
  VALUES (
    p_item_id, p_campaign_id, p_contact_id, p_session_id,
    'saida', p_mensagem, 'enviado', p_waha_message_id
  );

  PERFORM wacrm.increment_campaign_metric(p_campaign_id, 'total_enviados');
END;
$$;

-- ---------- Callback outbox + AI reply idempotency ----------
CREATE TABLE IF NOT EXISTS wacrm.campaign_callback_outbox (
  campaign_id uuid PRIMARY KEY REFERENCES wacrm.campaigns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sending','delivered')),
  owner_id text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz
);
ALTER TABLE wacrm.campaign_callback_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.campaign_callback_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.campaign_callback_outbox TO service_role;

CREATE TABLE IF NOT EXISTS wacrm.ai_reply_intents (
  account_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  node_key text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id, conversation_id, inbound_message_id, node_key)
);
ALTER TABLE wacrm.ai_reply_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.ai_reply_intents FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.ai_reply_intents TO service_role;

CREATE OR REPLACE FUNCTION wacrm.complete_dispatch_campaign(p_campaign_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_account uuid;
BEGIN
  SELECT status, account_id
  INTO v_status, v_account
  FROM wacrm.campaigns
  WHERE id = p_campaign_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'em_execucao' THEN RETURN false; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM wacrm.disp_message_queue
    WHERE campaign_id = p_campaign_id
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wacrm.disp_message_queue
    WHERE campaign_id = p_campaign_id
      AND (
        status IN ('agendado','enviando','pausado')
        OR (
          status = 'erro'
          AND COALESCE(erro_permanente, false) = false
          AND tentativas < 5
        )
      )
  ) THEN
    RETURN false;
  END IF;

  UPDATE wacrm.campaigns
  SET status = 'encerrada',
      updated_at = clock_timestamp()
  WHERE id = p_campaign_id;

  INSERT INTO wacrm.campaign_callback_outbox(campaign_id, account_id)
  VALUES(p_campaign_id, v_account)
  ON CONFLICT DO NOTHING;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.claim_campaign_callback(p_owner text)
RETURNS SETOF wacrm.campaign_callback_outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE wacrm.campaign_callback_outbox
  SET state = 'sending',
      owner_id = p_owner,
      lease_until = clock_timestamp() + interval '120 seconds',
      attempts = attempts + 1
  WHERE campaign_id = (
    SELECT campaign_id
    FROM wacrm.campaign_callback_outbox
    WHERE (
      state = 'pending' AND next_attempt_at <= clock_timestamp()
    ) OR (
      state = 'sending' AND lease_until < clock_timestamp()
    )
    ORDER BY next_attempt_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION wacrm.claim_ai_reply(
  p_account uuid,
  p_conversation uuid,
  p_message uuid,
  p_node text DEFAULT ''
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE inserted integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM wacrm.messages m
    WHERE m.id = p_message
      AND m.conversation_id = p_conversation
      AND m.account_id = p_account
      AND m.sender_type = 'customer'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO wacrm.ai_reply_intents(
    account_id, conversation_id, inbound_message_id, node_key
  )
  VALUES(
    p_account, p_conversation, p_message, COALESCE(p_node, '')
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END;
$$;

-- ---------- Cron progress ----------
CREATE OR REPLACE FUNCTION wacrm.renew_cron_lock(p_name text, p_owner text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE affected integer;
BEGIN
  UPDATE wacrm.cron_locks
  SET expires_at = clock_timestamp() + interval '600 seconds'
  WHERE name = p_name
    AND owner_id = p_owner
    AND expires_at > clock_timestamp();

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS assignment_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_assignment_retry
  ON wacrm.conversations(assignment_retry_at, updated_at)
  WHERE status = 'pending' AND assigned_agent_id IS NULL;

CREATE OR REPLACE FUNCTION wacrm.sweepable_flow_runs(p_limit integer DEFAULT 200)
RETURNS TABLE(
  id uuid,
  flow_id uuid,
  user_id uuid,
  contact_id uuid,
  last_advanced_at timestamptz,
  flows jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    r.id,
    r.flow_id,
    r.user_id,
    r.contact_id,
    r.last_advanced_at,
    jsonb_build_object('fallback_policy', f.fallback_policy)
  FROM wacrm.flow_runs r
  JOIN wacrm.flows f ON f.id = r.flow_id
  WHERE r.status = 'active'
    AND r.last_advanced_at < clock_timestamp() - (
      CASE
        WHEN jsonb_typeof(f.fallback_policy->'on_timeout_hours') = 'number'
        THEN CASE
          WHEN (f.fallback_policy->>'on_timeout_hours')::numeric > 0
          THEN (f.fallback_policy->>'on_timeout_hours')::numeric
          ELSE 24
        END
        ELSE 24
      END * interval '1 hour'
    )
  ORDER BY r.last_advanced_at
  LIMIT least(200, greatest(1, p_limit));
$$;

-- ---------- Manual/API send idempotency ----------
CREATE TABLE IF NOT EXISTS wacrm.send_operations (
  account_id uuid NOT NULL,
  operation_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','completed')),
  response_body jsonb,
  response_status integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id, operation_key)
);
ALTER TABLE wacrm.send_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.send_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.send_operations TO service_role;

CREATE OR REPLACE FUNCTION wacrm.reserve_send_operation(
  p_account uuid,
  p_key text,
  p_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE inserted integer;
BEGIN
  IF length(p_key) < 8 OR length(p_key) > 128 THEN
    RAISE EXCEPTION 'Invalid operation key';
  END IF;

  INSERT INTO wacrm.send_operations(account_id, operation_key, request_hash)
  VALUES(p_account, p_key, p_hash)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END;
$$;

-- ---------- Meta status receipts ----------
CREATE TABLE IF NOT EXISTS wacrm.dispatch_status_receipts (
  message_id text NOT NULL,
  status text NOT NULL,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(message_id, status)
);
ALTER TABLE wacrm.dispatch_status_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_status_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.dispatch_status_receipts TO service_role;

CREATE OR REPLACE FUNCTION wacrm.apply_dispatch_status(
  p_message_id text,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item wacrm.disp_message_queue%ROWTYPE;
  v_next text;
BEGIN
  IF p_status NOT IN ('delivered','read','failed') THEN RETURN false; END IF;

  INSERT INTO wacrm.dispatch_status_receipts(message_id, status, error_text)
  VALUES(p_message_id, p_status, p_error)
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE waha_message_id = p_message_id
  FOR UPDATE;

  IF NOT FOUND OR v_item.status = 'enviando' THEN RETURN false; END IF;

  IF p_status = 'delivered' AND v_item.status = 'enviado' THEN
    v_next := 'entregue';
  ELSIF p_status = 'read' AND v_item.status IN ('enviado', 'entregue') THEN
    v_next := 'lido';
  ELSIF p_status = 'failed' AND v_item.status = 'enviado' THEN
    v_next := 'erro';
  ELSE
    DELETE FROM wacrm.dispatch_status_receipts
    WHERE message_id = p_message_id AND status = p_status;
    RETURN false;
  END IF;

  UPDATE wacrm.disp_message_queue
  SET status = v_next,
      updated_at = clock_timestamp(),
      erro = CASE
        WHEN v_next = 'erro'
        THEN COALESCE(p_error, 'Falha de entrega; revisar antes de reenviar')
        ELSE erro
      END,
      erro_permanente = CASE
        WHEN v_next = 'erro' THEN true
        ELSE erro_permanente
      END
  WHERE id = v_item.id
    AND waha_message_id = p_message_id;

  IF v_next IN ('entregue', 'lido') AND v_item.status = 'enviado' THEN
    PERFORM wacrm.increment_campaign_metric(
      v_item.campaign_id, 'total_entregues'
    );
  END IF;

  IF v_next = 'lido' THEN
    PERFORM wacrm.increment_campaign_metric(v_item.campaign_id, 'total_lidos');
  END IF;

  IF v_next = 'erro' THEN
    PERFORM wacrm.increment_campaign_metric(v_item.campaign_id, 'total_erros');
  END IF;

  DELETE FROM wacrm.dispatch_status_receipts
  WHERE message_id = p_message_id AND status = p_status;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.replay_dispatch_receipts(p_message_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE receipt record;
BEGIN
  FOR receipt IN
    SELECT *
    FROM wacrm.dispatch_status_receipts
    WHERE message_id = p_message_id
    ORDER BY CASE status
      WHEN 'delivered' THEN 1
      WHEN 'read' THEN 2
      ELSE 3
    END
  LOOP
    PERFORM wacrm.apply_dispatch_status(
      receipt.message_id,
      receipt.status,
      receipt.error_text
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.reconcile_dispatch_receipts(
  p_limit integer DEFAULT 100
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE receipt record;
BEGIN
  FOR receipt IN
    SELECT DISTINCT r.message_id
    FROM wacrm.dispatch_status_receipts r
    JOIN wacrm.disp_message_queue q
      ON q.waha_message_id = r.message_id
    WHERE q.status <> 'enviando'
    LIMIT least(100, greatest(1, p_limit))
  LOOP
    PERFORM wacrm.replay_dispatch_receipts(receipt.message_id);
  END LOOP;
END;
$$;

-- ---------- Account-scoped log RPCs ----------
CREATE OR REPLACE FUNCTION wacrm.get_user_log_ranking_for_account(
  p_account_id uuid,
  p_from timestamptz
)
RETURNS TABLE(
  user_id uuid,
  full_name text,
  email text,
  error_count bigint,
  total_events bigint,
  last_seen timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    sl.user_id,
    p.full_name,
    p.email,
    COUNT(*) FILTER (
      WHERE sl.level IN ('error','critical')
    ) AS error_count,
    COUNT(*) AS total_events,
    MAX(sl.created_at) AS last_seen
  FROM wacrm.system_logs sl
  JOIN wacrm.profiles p ON p.user_id = sl.user_id
  WHERE sl.account_id = p_account_id
    AND sl.user_id IS NOT NULL
    AND sl.created_at >= p_from
  GROUP BY sl.user_id, p.full_name, p.email
  ORDER BY error_count DESC
  LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION wacrm.get_action_logs_for_account(
  p_account_id uuid,
  p_from timestamptz,
  p_cursor timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_user_id uuid DEFAULT NULL,
  p_action text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  account_id uuid,
  user_id uuid,
  page text,
  action text,
  level text,
  source text,
  event text,
  message text,
  payload jsonb,
  created_at timestamptz,
  user_name text,
  user_email text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    sl.id,
    sl.account_id,
    sl.user_id,
    sl.page,
    sl.action,
    sl.level,
    sl.source,
    sl.event,
    sl.message,
    sl.payload,
    sl.created_at,
    p.full_name,
    p.email
  FROM wacrm.system_logs sl
  LEFT JOIN wacrm.profiles p ON p.user_id = sl.user_id
  WHERE sl.account_id = p_account_id
    AND sl.source = 'frontend'
    AND sl.action IS NOT NULL
    AND sl.created_at >= p_from
    AND (p_cursor IS NULL OR sl.created_at < p_cursor)
    AND (p_user_id IS NULL OR sl.user_id = p_user_id)
    AND (p_action IS NULL OR sl.action = p_action)
  ORDER BY sl.created_at DESC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION wacrm.get_feedback_logs_for_account(
  p_account_id uuid,
  p_from timestamptz,
  p_cursor timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 200
)
RETURNS TABLE(
  id uuid,
  account_id uuid,
  user_id uuid,
  page text,
  level text,
  source text,
  event text,
  message text,
  payload jsonb,
  created_at timestamptz,
  user_name text,
  user_email text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    sl.id,
    sl.account_id,
    sl.user_id,
    sl.page,
    sl.level,
    sl.source,
    sl.event,
    sl.message,
    sl.payload,
    sl.created_at,
    p.full_name,
    p.email
  FROM wacrm.system_logs sl
  LEFT JOIN wacrm.profiles p ON p.user_id = sl.user_id
  WHERE sl.account_id = p_account_id
    AND sl.source = 'feedback'
    AND sl.created_at >= p_from
    AND (p_cursor IS NULL OR sl.created_at < p_cursor)
  ORDER BY sl.created_at DESC
  LIMIT p_limit;
$$;

-- ---------- Private chat-media bucket ----------
INSERT INTO storage.buckets(
  id, name, public, file_size_limit, allowed_mime_types
)
VALUES (
  'chat-media',
  'chat-media',
  false,
  16777216,
  ARRAY[
    'image/png','image/jpeg','image/webp',
    'video/mp4','video/3gpp',
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'audio/ogg','audio/mpeg','audio/aac','audio/mp4','audio/amr','audio/webm'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Account members can read chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;

CREATE POLICY "Account members can read chat media"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat-media'
  AND EXISTS (
    SELECT 1
    FROM wacrm.profiles p
    WHERE p.user_id = auth.uid()
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  )
);

CREATE POLICY "Members can upload chat media"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'chat-media'
  AND EXISTS (
    SELECT 1
    FROM wacrm.profiles p
    WHERE p.user_id = auth.uid()
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  )
);

CREATE POLICY "Members can update chat media"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'chat-media'
  AND EXISTS (
    SELECT 1
    FROM wacrm.profiles p
    WHERE p.user_id = auth.uid()
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  )
)
WITH CHECK (
  bucket_id = 'chat-media'
  AND EXISTS (
    SELECT 1
    FROM wacrm.profiles p
    WHERE p.user_id = auth.uid()
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  )
);

CREATE POLICY "Members can delete chat media"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'chat-media'
  AND EXISTS (
    SELECT 1
    FROM wacrm.profiles p
    WHERE p.user_id = auth.uid()
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  )
);

-- ---------- Final transient retry policy (includes Meta 131026 guard) ----------
CREATE OR REPLACE FUNCTION wacrm.retry_transient_queue_errors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE wacrm.disp_message_queue q
  SET status = 'agendado',
      scheduled_at = clock_timestamp()
        + (q.tentativas * q.tentativas * interval '1 minute'),
      updated_at = clock_timestamp()
  WHERE q.status = 'erro'
    AND COALESCE(q.erro_permanente, false) = false
    AND q.tentativas < 5
    AND COALESCE(q.sent_at, q.created_at)
        < clock_timestamp() - interval '5 minutes'
    AND COALESCE(q.erro, '') NOT ILIKE '%131026%'
    AND EXISTS (
      SELECT 1
      FROM wacrm.campaigns c
      WHERE c.id = q.campaign_id
        AND c.status = 'em_execucao'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM wacrm.blacklist b
      WHERE (b.account_id = q.account_id OR b.account_id IS NULL)
        AND regexp_replace(COALESCE(b.telefone, ''), '\D', '', 'g')
          = regexp_replace(
              COALESCE(
                CASE
                  WHEN q.contact_id IS NULL THEN q.mensagem_final
                  ELSE (
                    SELECT ct.phone
                    FROM wacrm.contacts ct
                    WHERE ct.id = q.contact_id
                  )
                END,
                ''
              ),
              '\D',
              '',
              'g'
            )
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Reconcile legacy 131026 rows that are still retry-eligible.
DO $$
DECLARE v_campaign_id uuid;
BEGIN
  FOR v_campaign_id IN
    SELECT DISTINCT q.campaign_id
    FROM wacrm.disp_message_queue q
    WHERE q.campaign_id IS NOT NULL
      AND q.status IN ('agendado','erro')
      AND COALESCE(q.erro_permanente, false) = false
      AND COALESCE(q.erro, '') ILIKE '%131026%'
  LOOP
    UPDATE wacrm.disp_message_queue
    SET status = 'bloqueado',
        erro_permanente = true,
        updated_at = clock_timestamp()
    WHERE campaign_id = v_campaign_id
      AND status IN ('agendado','erro')
      AND COALESCE(erro_permanente, false) = false
      AND COALESCE(erro, '') ILIKE '%131026%';

    PERFORM wacrm.recalculate_campaign_metrics(v_campaign_id);
  END LOOP;
END;
$$;

-- ---------- Security hardening for internal helpers ----------
ALTER FUNCTION wacrm.increment_campaign_metric(uuid, text)
  SET search_path = '';

REVOKE ALL ON FUNCTION wacrm.reserve_campaign_tick(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.claim_dispatch_item(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.complete_dispatch_campaign(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.resume_dispatch_campaign(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.stop_dispatch_campaign(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.mark_queue_item_sent(
  uuid, uuid, uuid, uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.claim_campaign_callback(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.claim_ai_reply(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.renew_cron_lock(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.sweepable_flow_runs(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.reserve_send_operation(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.apply_dispatch_status(text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.replay_dispatch_receipts(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.reconcile_dispatch_receipts(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.retry_transient_queue_errors()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.get_user_log_ranking_for_account(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.get_action_logs_for_account(
  uuid, timestamptz, timestamptz, integer, uuid, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.get_feedback_logs_for_account(
  uuid, timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.set_message_account_id()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION wacrm.reserve_campaign_tick(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.claim_dispatch_item(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.complete_dispatch_campaign(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.resume_dispatch_campaign(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.stop_dispatch_campaign(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.mark_queue_item_sent(
  uuid, uuid, uuid, uuid, text, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.claim_campaign_callback(text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.claim_ai_reply(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.renew_cron_lock(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.sweepable_flow_runs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.reserve_send_operation(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.apply_dispatch_status(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.replay_dispatch_receipts(text) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.reconcile_dispatch_receipts(integer) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.retry_transient_queue_errors() TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.get_user_log_ranking_for_account(uuid, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.get_action_logs_for_account(
  uuid, timestamptz, timestamptz, integer, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.get_feedback_logs_for_account(
  uuid, timestamptz, timestamptz, integer
) TO service_role;

-- Legacy internal RPCs: retain for compatibility, but remove browser/anon access.
DO $$
DECLARE v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wacrm'
      AND p.proname IN (
        'increment_unread_count',
        'increment_session_page_count',
        'recalculate_campaign_metrics',
        'increment_campaign_metric',
        'claim_queue_item',
        'mark_queue_item_sent',
        'get_action_logs',
        'get_user_log_ranking',
        'get_feedback_logs'
      )
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      v_function.signature
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      v_function.signature
    );
  END LOOP;
END;
$$;

ALTER TABLE wacrm.cron_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.cron_locks FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.cron_locks TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
