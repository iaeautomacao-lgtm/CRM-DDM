-- ============================================================
-- 185_webhook_status_inbox.sql
--
-- Webhook de status da Meta DURÁVEL e EM LOTE (P1-2, capacidade 80 envios/s por número).
--
-- Problema (auditoria DISP-AUDIT §1.3/5, achados W1–W4):
--  - cada delivered/read/failed fazia 3 chamadas HTTP ao banco DEPOIS do 200 (SELECT messages,
--    RPC apply_dispatch_status, UPDATE whatsapp_test_sends) e vivia só em memória: reinício/erro
--    entre o 200 e o fim do after() perdia o recibo para sempre (W2);
--  - apply_dispatch_status não conferia a conta (W1);
--  - ordem de locks invertida entre apply_dispatch_status (item → advisory do telefone) e
--    confirm_pending_meta_131026 (advisory → item): deadlock raro (W3).
--
-- O que esta migration faz:
--  1) wacrm.webhook_status_inbox — fila durável, UNIQUE(message_id, status): a Meta reenviar o mesmo
--     status é absorvido (ON CONFLICT DO NOTHING). Guarda só o mínimo (wamid, status, erro, conta/canal
--     que validaram o HMAC, horário do evento). Retenção: processadas > 3 dias são apagadas (5.000 por vez).
--  2) wacrm.ingest_status_events(jsonb) — grava o lote ANTES do 200 (uma chamada por POST). O app
--     responde 500 se falhar, para a Meta reenviar.
--  3) wacrm.apply_dispatch_statuses(p_limit) — aplica o lote: FOR UPDATE SKIP LOCKED (vários
--     drenadores sem colisão), precedência read > delivered (failed nunca vale sobre entregue/lido),
--     UPDATE … FROM no caminho comum (item 'enviado'/'entregue' → 'entregue'/'lido'), métricas
--     AGREGADAS por campanha direto em campaign_metric_deltas (migration 183), messages e
--     whatsapp_test_sends em lote. failed / 131026 / item 'enviando' / qualquer outro caso seguem a
--     função atual wacrm.apply_dispatch_status POR ITEM (mesma regra da 172), numa subtransação:
--     erro de um item não desfaz o lote (o item volta para a fila com attempts+1; após 5, é descartado).
--     Tudo confere a CONTA do canal que validou o HMAC (W1): wamid de item de outra conta é ignorado.
--  4) wacrm.apply_dispatch_status_scoped(conta, wamid, status, erro) — wrapper que confere a conta
--     antes de chamar apply_dispatch_status (a função de 3 argumentos continua igual, para o replay).
--  5) wacrm.try_claim_status_drain(p_interval_ms) — "vez" de drenar o inbox no máximo ~1×/s em todo o
--     cluster (linha em cron_locks com validade curta; o lock do cron tem TTL mínimo de 30 s). O webhook
--     (after()) chama; quem não ganha a vez não faz nada — o cron de 1/min é a rede de segurança.
--  6) wacrm.confirm_pending_meta_131026 — mesma regra da 172, agora travando a LINHA DO ITEM antes do
--     advisory do telefone (mesma ordem de apply_dispatch_status): sem deadlock (W3).
--
-- COMPATIBILIDADE: o app detecta a ausência destas funções (PGRST202/42883) e cai no caminho antigo
-- (3 chamadas por evento, depois do 200) — então a migration pode ser aplicada antes OU depois do
-- deploy; só o ganho de capacidade e a durabilidade dependem dela.
--
-- PRÉ-CHECK (rodar antes):
--   SELECT pg_get_functiondef('wacrm.apply_dispatch_status(text,text,text)'::regprocedure);
--   -- se o corpo de produção divergir da 172, a divergência continua valendo (esta migration NÃO o altera);
--   SELECT to_regclass('wacrm.campaign_metric_deltas');   -- 183 aplicada (não nulo)
--   SELECT to_regclass('wacrm.webhook_status_inbox');     -- NULL antes
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.apply_dispatch_status(text,text,text)') IS NULL
     OR to_regclass('wacrm.dispatch_status_receipts') IS NULL
     OR to_regclass('wacrm.disp_message_queue') IS NULL
     OR to_regclass('wacrm.dispatch_meta_131026_failures') IS NULL
     OR to_regclass('wacrm.cron_locks') IS NULL THEN
    RAISE EXCEPTION '185: aplique a 172 (apply_dispatch_status, recibos e 131026) antes';
  END IF;
  IF to_regclass('wacrm.campaign_metric_deltas') IS NULL THEN
    RAISE EXCEPTION '185: aplique a 183 (campaign_metric_deltas) antes — o lote grava métricas por delta';
  END IF;
END $$;

-- ---------- 1) fila durável ----------
CREATE TABLE IF NOT EXISTS wacrm.webhook_status_inbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid,
  channel_id   uuid,
  message_id   text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('delivered', 'read', 'failed')),
  error_text   text,
  event_ts     timestamptz,
  received_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text,
  CONSTRAINT webhook_status_inbox_message_status_key UNIQUE (message_id, status)
);

-- Fila de pendentes (drenagem por ordem de chegada) e retenção das processadas.
CREATE INDEX IF NOT EXISTS idx_webhook_status_inbox_pending
  ON wacrm.webhook_status_inbox (id) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_status_inbox_processed
  ON wacrm.webhook_status_inbox (processed_at) WHERE processed_at IS NOT NULL;

ALTER TABLE wacrm.webhook_status_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.webhook_status_inbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.webhook_status_inbox TO service_role;

-- ---------- 2) ingestão (antes do 200) ----------
CREATE OR REPLACE FUNCTION wacrm.ingest_status_events(p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN RETURN 0; END IF;

  WITH ins AS (
    INSERT INTO wacrm.webhook_status_inbox(account_id, channel_id, message_id, status, error_text, event_ts)
    SELECT e.account_id, e.channel_id, e.message_id, e.status, e.error_text, to_timestamp(e.ts)
    FROM jsonb_to_recordset(p_events) AS e(
      account_id uuid, channel_id uuid, message_id text, status text, error_text text, ts double precision
    )
    WHERE e.message_id IS NOT NULL AND e.message_id <> ''
      AND e.status IN ('delivered', 'read', 'failed')
    ON CONFLICT (message_id, status) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_inserted FROM ins;

  RETURN COALESCE(v_inserted, 0);
END;
$$;

-- ---------- 3) métricas agregadas por delta ----------
-- (a 183 faz increment_campaign_metric inserir 1 delta por chamada; aqui o lote insere n de uma vez)

-- ---------- 4) wrapper com conta (W1) ----------
CREATE OR REPLACE FUNCTION wacrm.apply_dispatch_status_scoped(
  p_account_id uuid,
  p_message_id text,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Item de OUTRA conta com esse wamid: o POST foi assinado pelo canal de uma conta e não pode
  -- alterar status/métricas/blacklist de outra (W1). Item sem conta (legado) segue como antes.
  IF p_account_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM wacrm.disp_message_queue q
    WHERE q.waha_message_id = p_message_id
      AND q.account_id IS NOT NULL
      AND q.account_id <> p_account_id
  ) THEN
    RETURN false;
  END IF;
  RETURN wacrm.apply_dispatch_status(p_message_id, p_status, p_error);
END;
$$;

-- ---------- 5) aplicação em lote ----------
CREATE OR REPLACE FUNCTION wacrm.apply_dispatch_statuses(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids        bigint[];
  v_retry_ids  bigint[] := ARRAY[]::bigint[];
  v_handled    text[]   := ARRAY[]::text[];
  v_skip       text[]   := ARRAY[]::text[];
  v_fast       integer  := 0;
  v_slow       integer  := 0;
  v_failed     integer  := 0;
  v_attempts   integer;
  r            record;
BEGIN
  -- Reserva o lote (vários drenadores ao mesmo tempo não se atropelam).
  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids
  FROM (
    SELECT i.id
    FROM wacrm.webhook_status_inbox i
    WHERE i.processed_at IS NULL
    ORDER BY i.id
    LIMIT GREATEST(COALESCE(p_limit, 500), 1)
    FOR UPDATE SKIP LOCKED
  ) s;

  IF v_ids IS NULL THEN
    -- Ocioso: aproveita para podar o que já foi processado há mais de 3 dias.
    DELETE FROM wacrm.webhook_status_inbox
    WHERE id IN (
      SELECT d.id FROM wacrm.webhook_status_inbox d
      WHERE d.processed_at < clock_timestamp() - interval '3 days'
      LIMIT 5000
    );
    RETURN jsonb_build_object('claimed', 0, 'fast', 0, 'slow', 0, 'failed', 0);
  END IF;

  -- (a) Caminho comum, em lote: item 'enviado'/'entregue' + delivered/read, sem 131026 pendente.
  -- Precedência read > delivered; failed nunca vale sobre entregue/lido (o failed desses wamids é descartado).
  -- Linhas travadas em ORDEM DE ID (mesma ordem em qualquer drenador).
  WITH best AS (
    SELECT i.message_id,
           (array_agg(i.account_id) FILTER (WHERE i.account_id IS NOT NULL))[1] AS account_id,
           max(CASE i.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END) AS rank
    FROM wacrm.webhook_status_inbox i
    WHERE i.id = ANY (v_ids)
    GROUP BY i.message_id
  ),
  cand AS (
    SELECT q.id, q.campaign_id, q.status AS old_status, q.waha_message_id AS message_id, b.rank
    FROM best b
    JOIN wacrm.disp_message_queue q ON q.waha_message_id = b.message_id
    WHERE b.rank >= 2
      AND q.status IN ('enviado', 'entregue')
      AND NOT q.entrega_pendente_131026
      AND (b.account_id IS NULL OR q.account_id IS NULL OR q.account_id = b.account_id)
    ORDER BY q.id
    FOR UPDATE OF q
  ),
  upd AS (
    UPDATE wacrm.disp_message_queue q
    SET status = CASE WHEN c.rank = 3 THEN 'lido' ELSE 'entregue' END,
        updated_at = clock_timestamp()
    FROM cand c
    WHERE q.id = c.id
      AND NOT (c.rank = 2 AND c.old_status = 'entregue')
    RETURNING q.campaign_id, c.old_status, q.status AS new_status
  ),
  agg AS (
    SELECT u.campaign_id,
           count(*) FILTER (WHERE u.old_status = 'enviado')::integer AS entregues,
           count(*) FILTER (WHERE u.new_status = 'lido')::integer    AS lidos
    FROM upd u
    GROUP BY u.campaign_id
  ),
  metrics AS (
    INSERT INTO wacrm.campaign_metric_deltas(campaign_id, field, n)
    SELECT a.campaign_id, 'total_entregues', a.entregues FROM agg a WHERE a.entregues > 0
    UNION ALL
    SELECT a.campaign_id, 'total_lidos', a.lidos FROM agg a WHERE a.lidos > 0
    RETURNING 1
  )
  SELECT COALESCE(array_agg(DISTINCT c.message_id), ARRAY[]::text[]),
         (SELECT count(*)::integer FROM upd)
  INTO v_handled, v_fast
  FROM cand c;

  IF cardinality(v_handled) > 0 THEN
    -- Recibos guardados para esses wamids já não servem (a transição foi aplicada ou era velha).
    DELETE FROM wacrm.dispatch_status_receipts WHERE message_id = ANY (v_handled);
  END IF;

  -- (b) Status de mensagens do Inbox/IA/fluxo (sem item de campanha): nada a aplicar na fila.
  SELECT COALESCE(array_agg(DISTINCT i.message_id), ARRAY[]::text[]) INTO v_skip
  FROM wacrm.webhook_status_inbox i
  WHERE i.id = ANY (v_ids)
    AND i.message_id <> ALL (v_handled)
    AND NOT EXISTS (SELECT 1 FROM wacrm.disp_message_queue q WHERE q.waha_message_id = i.message_id)
    AND EXISTS (SELECT 1 FROM wacrm.messages m WHERE m.message_id = i.message_id);

  -- (c) O resto (failed, 131026, item 'enviando', wamid ainda desconhecido…): função atual por item,
  -- uma subtransação por item — erro de um não desfaz o lote.
  FOR r IN
    SELECT i.id, i.account_id, i.message_id, i.status, i.error_text
    FROM wacrm.webhook_status_inbox i
    WHERE i.id = ANY (v_ids)
      AND i.message_id <> ALL (v_handled)
      AND i.message_id <> ALL (v_skip)
    ORDER BY i.id
  LOOP
    BEGIN
      PERFORM wacrm.apply_dispatch_status_scoped(r.account_id, r.message_id, r.status, r.error_text);
      v_slow := v_slow + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      UPDATE wacrm.webhook_status_inbox
      SET attempts = attempts + 1, last_error = left(SQLERRM, 500)
      WHERE id = r.id
      RETURNING attempts INTO v_attempts;
      -- Volta para a fila (tenta no próximo ciclo) até 5 tentativas; depois é descartado.
      IF v_attempts < 5 THEN v_retry_ids := array_append(v_retry_ids, r.id); END IF;
    END;
  END LOOP;

  -- (d) messages (Inbox) em lote — mesmas transições do webhook, escopadas pela conta da conversa.
  WITH best AS (
    SELECT i.message_id,
           (array_agg(i.account_id) FILTER (WHERE i.account_id IS NOT NULL))[1] AS account_id,
           max(CASE i.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END) AS rank
    FROM wacrm.webhook_status_inbox i
    WHERE i.id = ANY (v_ids)
    GROUP BY i.message_id
  )
  UPDATE wacrm.messages m
  SET status = CASE b.rank WHEN 3 THEN 'read' WHEN 2 THEN 'delivered' ELSE 'failed' END
  FROM best b, wacrm.conversations c
  WHERE m.message_id = b.message_id
    AND c.id = m.conversation_id
    AND (b.account_id IS NULL OR c.account_id = b.account_id)
    AND (
      (b.rank = 3 AND m.status IN ('pending', 'sending', 'sent', 'delivered', 'failed'))
      OR (b.rank = 2 AND m.status IN ('pending', 'sending', 'sent', 'failed'))
      OR (b.rank = 1 AND m.status IN ('pending', 'sending', 'sent'))
    );

  -- (e) whatsapp_test_sends ("Testar canal"): UMA atualização por lote; quase sempre 0 linhas.
  IF to_regclass('wacrm.whatsapp_test_sends') IS NOT NULL THEN
    EXECUTE $q$
      WITH best AS (
        SELECT i.message_id,
               max(CASE i.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END) AS rank,
               (array_agg(i.error_text ORDER BY i.id DESC))[1] AS err
        FROM wacrm.webhook_status_inbox i
        WHERE i.id = ANY ($1)
        GROUP BY i.message_id
      )
      UPDATE wacrm.whatsapp_test_sends t
      SET status = CASE b.rank WHEN 3 THEN 'read' WHEN 2 THEN 'delivered' ELSE 'failed' END,
          erro = CASE WHEN b.rank = 1 THEN COALESCE(b.err, 'Falha na entrega (Meta)') ELSE NULL END
      FROM best b
      WHERE t.message_id = b.message_id
        AND (
          (b.rank = 3 AND t.status IN ('sent', 'delivered', 'failed'))
          OR (b.rank = 2 AND t.status IN ('sent', 'failed'))
          OR (b.rank = 1 AND t.status NOT IN ('delivered', 'read'))
        )
    $q$ USING v_ids;
  END IF;

  -- (f) Marca processadas (as que falharam voltam para a próxima rodada, até 5 tentativas).
  UPDATE wacrm.webhook_status_inbox
  SET processed_at = clock_timestamp()
  WHERE id = ANY (v_ids)
    AND id <> ALL (v_retry_ids);

  RETURN jsonb_build_object(
    'claimed', cardinality(v_ids),
    'fast', v_fast,
    'slow', v_slow,
    'failed', v_failed
  );
END;
$$;

-- ---------- 5b) vez de drenar (~1×/s no cluster) ----------
CREATE OR REPLACE FUNCTION wacrm.try_claim_status_drain(p_interval_ms integer DEFAULT 1000)
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
    'webhook_status_drain', 'drain', clock_timestamp(),
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

-- ---------- 6) W3: ordem de locks consistente em confirm_pending_meta_131026 ----------
-- Mesma regra da 172; a única diferença é travar a LINHA DO ITEM antes do advisory do telefone
-- (apply_dispatch_status faz item → advisory; antes esta função fazia advisory → item).
CREATE OR REPLACE FUNCTION wacrm.confirm_pending_meta_131026(
  p_window_minutes integer DEFAULT 1440,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  v_confirmed integer := 0;
  v_rows integer;
BEGIN
  FOR r IN
    SELECT id, account_id, telefone, campaign_id, queue_id
    FROM wacrm.dispatch_meta_131026_failures
    WHERE status = 'pendente'
      AND created_at < clock_timestamp()
        - pg_catalog.make_interval(mins => GREATEST(COALESCE(p_window_minutes, 1440), 0))
    ORDER BY created_at
    LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    -- W3: item primeiro, advisory depois (mesma ordem de apply_dispatch_status).
    IF r.queue_id IS NOT NULL THEN
      PERFORM 1 FROM wacrm.disp_message_queue WHERE id = r.queue_id FOR UPDATE;
    END IF;

    -- Mesmo lock de record/apply: serializa por telefone.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(r.account_id::text || ':' || r.telefone, 0)
    );

    UPDATE wacrm.dispatch_meta_131026_failures
    SET status = 'confirmado', confirmed_at = now()
    WHERE id = r.id AND status = 'pendente';
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows > 0 THEN
      v_confirmed := v_confirmed + 1;

      -- Agora é erro definitivo: o item sai de "aguardando confirmação".
      IF r.queue_id IS NOT NULL THEN
        UPDATE wacrm.disp_message_queue
        SET status = 'erro',
            erro = 'Meta: Message undeliverable (code 131026)',
            erro_permanente = true,
            entrega_pendente_131026 = false,
            updated_at = clock_timestamp()
        WHERE id = r.queue_id
          AND status = 'enviado'
          AND entrega_pendente_131026;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows > 0 THEN
          PERFORM wacrm.increment_campaign_metric(r.campaign_id, 'total_erros');
        END IF;
      END IF;

      PERFORM wacrm.meta_131026_apply_rule(r.account_id, r.telefone, r.campaign_id);
    END IF;
  END LOOP;

  RETURN v_confirmed;
END;
$$;

-- ---------- grants ----------
REVOKE ALL ON FUNCTION wacrm.ingest_status_events(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.ingest_status_events(jsonb) TO service_role;
REVOKE ALL ON FUNCTION wacrm.apply_dispatch_status_scoped(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.apply_dispatch_status_scoped(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION wacrm.apply_dispatch_statuses(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.apply_dispatch_statuses(integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.try_claim_status_drain(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.try_claim_status_drain(integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.confirm_pending_meta_131026(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.confirm_pending_meta_131026(integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
