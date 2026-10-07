-- ============================================================
-- 167_dispatch_claim_o1_retry_receipts.sql
--
-- Capacidade do disparador (fase 1): tira do caminho de cada envio os
-- custos que cresciam com o tamanho da fila.
--
-- 1) wacrm.claim_dispatch_item_capped / claim_dispatch_item — claim com
--    custo constante quando a campanha NÃO tem limite_por_hora:
--    - antes: SELECT … FOR UPDATE na campanha (serializava TODOS os claims
--      da campanha, em todos os números) e, sempre, count(*) dos envios da
--      última hora da campanha (~150k linhas a 2.500/min) com a campanha
--      travada → teto de ~10–30 claims/s por campanha;
--    - agora: lê a campanha sem lock e decide o modo ANTES de travar
--      (nunca sobe de FOR SHARE para FOR UPDATE na mesma transação):
--        limite_por_hora nulo/0 → FOR SHARE, sem contagem horária. Ainda
--          conflita com stop/complete_dispatch_campaign (FOR UPDATE) e com
--          UPDATEs da campanha (pausar), mas não entre claims;
--        limite_por_hora > 0 → FOR UPDATE + contagem (igual à 133/164).
--      Se o limite mudar entre a leitura e o lock, o item é recusado
--      (volta no próximo tick) em vez de contar sem o lock certo.
--    - mantém: advisory lock por session_id (serializa claims do mesmo
--      número entre campanhas), max_in_flight (contagem de 'enviando' pelo
--      índice parcial idx_dispatch_channel_in_flight), hourly_limit do
--      canal só quando não nulo, item 'agendado'/vencido/sem
--      waha_message_id, campanha 'em_execucao'.
--    claim_dispatch_item(p) passa a ser claim_dispatch_item_capped(p, NULL),
--    que resolve o teto sem linha para 4 — exatamente o comportamento de
--    antes. ANTES de aplicar, confira o corpo de produção:
--      SELECT pg_get_functiondef('wacrm.claim_dispatch_item(uuid)'::regprocedure);
--      SELECT pg_get_functiondef('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure);
--    Se divergirem da 133/164, replique aqui a diferença.
--
-- 2) wacrm.phone_key(text) — mesma chave de src/lib/disparador/phone-key.ts
--    (phoneKey): iguala +55/sem 55, máscara e 9º dígito de celular. IMMUTABLE
--    para servir de índice de expressão na blacklist (migration 168).
--
-- 3) wacrm.retry_transient_queue_errors() — mesma regra da 133, mas:
--    - predicado compatível com o índice parcial idx_dmq_retryable (168):
--      erro_permanente IS NOT TRUE (= COALESCE(…, false) = false);
--    - blacklist pela chave normalizada (wacrm.phone_key) em vez de regex
--      em toda a blacklist para cada linha. A chave é a mesma que o
--      startCampaign usa para excluir números; bate também variações
--      (com/sem 55, 9º dígito), então nunca reabre um item que o envio
--      bloquearia.
--    O cron passa a chamá-la a cada ~5 ticks (lock disparador_retry).
--
-- 4) wacrm.apply_dispatch_status — mesma regra da 166, sem recibo órfão:
--    o recibo só é gravado quando pode ser reaplicado depois — item ainda
--    'enviando', ou nenhum item com esse message_id E a mensagem não é do
--    Inbox/IA/fluxo (wacrm.messages). Antes era gravado sempre e ficava
--    para sempre quando a mensagem não era de campanha (~2 linhas por
--    mensagem de saída fora de campanha). Transição aplicada na hora não
--    grava recibo (antes: insert + delete na mesma transação).
--
-- 5) wacrm.confirm_dispatch_item_sent(...) — mark_queue_item_sent +
--    replay_dispatch_receipts numa chamada só (uma ida ao banco a menos por
--    envio). O replay só roda se houver recibo guardado e falha dele não
--    desfaz a confirmação (subtransação), igual ao app antes.
--
-- 6) wacrm.blacklisted_phone_keys(text[]) — devolve quais chaves
--    (wacrm.phone_key) estão na blacklist. O cron revalida a blacklist de
--    todos os candidatos do tick numa chamada (antes: 1 select por envio).
--
-- ORDEM: aplicar ANTES do deploy do código (o app cai no caminho antigo se
-- as funções novas não existirem, então depois também funciona). Depois
-- desta, rodar a 168 (índices, cada instrução sozinha).
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

-- ---------- 1) claim O(1) ----------
CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_item_capped(
  p_item_id uuid,
  p_default_max_in_flight integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item wacrm.disp_message_queue%ROWTYPE;
  v_campaign wacrm.campaigns%ROWTYPE;
  v_hourly_limit integer;
  v_count bigint;
  v_concurrency integer := 4;
  v_channel_limit integer;
BEGIN
  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE id = p_item_id;

  IF NOT FOUND OR v_item.session_id IS NULL THEN RETURN false; END IF;

  -- Leitura sem lock só para escolher o modo do lock.
  SELECT limite_por_hora INTO v_hourly_limit
  FROM wacrm.campaigns
  WHERE id = v_item.campaign_id;

  IF NOT FOUND THEN RETURN false; END IF;

  IF COALESCE(v_hourly_limit, 0) > 0 THEN
    SELECT * INTO v_campaign
    FROM wacrm.campaigns
    WHERE id = v_item.campaign_id
    FOR UPDATE;
  ELSE
    SELECT * INTO v_campaign
    FROM wacrm.campaigns
    WHERE id = v_item.campaign_id
    FOR SHARE;
  END IF;

  IF NOT FOUND
     OR v_campaign.status <> 'em_execucao'
     -- Limite ligado entre a leitura e o lock: o lock compartilhado não
     -- protege a contagem; recusa (o item volta no próximo tick).
     OR (COALESCE(v_hourly_limit, 0) <= 0 AND COALESCE(v_campaign.limite_por_hora, 0) > 0)
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

  -- Contagem horária da campanha só quando há limite (com FOR UPDATE).
  IF COALESCE(v_campaign.limite_por_hora, 0) > 0 THEN
    SELECT count(*) INTO v_count
    FROM wacrm.disp_message_queue
    WHERE campaign_id = v_campaign.id
      AND (
        status = 'enviando'
        OR sent_at >= clock_timestamp() - interval '1 hour'
      );

    IF v_count >= v_campaign.limite_por_hora THEN RETURN false; END IF;
  END IF;

  SELECT max_in_flight, hourly_limit
  INTO v_concurrency, v_channel_limit
  FROM wacrm.dispatch_channel_limits
  WHERE session_id = v_item.session_id;

  -- Sem linha do canal: padrão do app (faixa 1..50, a mesma do CHECK de
  -- max_in_flight); NULL → 4 (claim_dispatch_item).
  v_concurrency := COALESCE(
    v_concurrency,
    CASE WHEN p_default_max_in_flight BETWEEN 1 AND 50 THEN p_default_max_in_flight END,
    4
  );

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

CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_item(p_item_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT wacrm.claim_dispatch_item_capped(p_item_id, NULL);
$$;

REVOKE ALL ON FUNCTION wacrm.claim_dispatch_item_capped(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_dispatch_item_capped(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.claim_dispatch_item(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_dispatch_item(uuid) TO service_role;

-- ---------- 2) chave de telefone (= phoneKey de phone-key.ts) ----------
CREATE OR REPLACE FUNCTION wacrm.phone_key(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  v_digits text := pg_catalog.regexp_replace(COALESCE(p_raw, ''), '\D', '', 'g');
  v_national text := v_digits;
  v_local text;
BEGIN
  IF left(v_national, 2) = '55' AND length(v_national) IN (12, 13) THEN
    v_national := substr(v_national, 3);
  END IF;
  -- Fora do padrão BR: os próprios dígitos.
  IF length(v_national) NOT IN (10, 11) THEN RETURN v_digits; END IF;
  v_local := substr(v_national, 3);
  -- 9º dígito ignorado só na faixa de celular (6–9).
  IF length(v_local) = 9 AND left(v_local, 1) = '9' AND substr(v_local, 2, 1) IN ('6', '7', '8', '9') THEN
    RETURN left(v_national, 2) || substr(v_local, 2);
  END IF;
  RETURN v_national;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.phone_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.phone_key(text) TO service_role;

-- ---------- 3) retry indexado ----------
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
  -- Mesmo predicado do índice parcial idx_dmq_retryable (migration 168).
  WHERE q.status = 'erro'
    AND q.erro_permanente IS NOT TRUE
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
        -- Índice de expressão idx_blacklist_phone_key (migration 168).
        AND wacrm.phone_key(b.telefone) = wacrm.phone_key(
          CASE
            WHEN q.contact_id IS NULL THEN q.mensagem_final
            ELSE (
              SELECT ct.phone
              FROM wacrm.contacts ct
              WHERE ct.id = q.contact_id
            )
          END
        )
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.retry_transient_queue_errors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.retry_transient_queue_errors() TO service_role;

-- ---------- 4) status sem recibo órfão (base: 166) ----------
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
  v_phone text;
BEGIN
  IF p_status NOT IN ('delivered','read','failed') THEN RETURN false; END IF;

  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE waha_message_id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Mensagem do Inbox/IA/fluxo: nunca vira item de campanha, então o
    -- recibo nunca seria reaplicado (ficava órfão para sempre).
    IF EXISTS (
      SELECT 1 FROM wacrm.messages m WHERE m.message_id = p_message_id
    ) THEN
      RETURN false;
    END IF;
    -- Pode ser envio de campanha ainda sem confirmação local
    -- (mark_queue_item_sent grava o waha_message_id): guarda para o replay.
    INSERT INTO wacrm.dispatch_status_receipts(message_id, status, error_text)
    VALUES(p_message_id, p_status, p_error)
    ON CONFLICT DO NOTHING;
    RETURN false;
  END IF;

  IF v_item.status = 'enviando' THEN
    -- Confirmação local pendente: replay/reconcile aplicam depois.
    INSERT INTO wacrm.dispatch_status_receipts(message_id, status, error_text)
    VALUES(p_message_id, p_status, p_error)
    ON CONFLICT DO NOTHING;
    RETURN false;
  END IF;

  IF p_status = 'delivered' AND v_item.status = 'enviado' THEN
    v_next := 'entregue';
  ELSIF p_status = 'read' AND v_item.status IN ('enviado', 'entregue') THEN
    v_next := 'lido';
  ELSIF p_status = 'failed' AND v_item.status = 'enviado' THEN
    v_next := 'erro';
  ELSE
    -- Transição velha/duplicada: descarta (inclusive recibo guardado antes).
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

    IF COALESCE(p_error, '') ILIKE '%131026%'
       AND v_item.account_id IS NOT NULL
       AND v_item.campaign_id IS NOT NULL
       AND v_item.contact_id IS NOT NULL THEN
      SELECT c.phone INTO v_phone
      FROM wacrm.contacts c
      WHERE c.id = v_item.contact_id;

      IF COALESCE(v_phone, '') <> '' THEN
        PERFORM wacrm.record_meta_131026_failure(
          v_item.account_id,
          v_phone,
          v_item.campaign_id
        );
      END IF;
    END IF;
  END IF;

  -- Recibo guardado antes (replay/reconcile) foi aplicado agora.
  DELETE FROM wacrm.dispatch_status_receipts
  WHERE message_id = p_message_id AND status = p_status;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.apply_dispatch_status(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.apply_dispatch_status(text, text, text)
  TO service_role;

-- ---------- 5) confirmação + replay numa ida ----------
CREATE OR REPLACE FUNCTION wacrm.confirm_dispatch_item_sent(
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
BEGIN
  -- Erro aqui desfaz tudo e volta ao app (mesmo tratamento de antes).
  PERFORM wacrm.mark_queue_item_sent(
    p_item_id, p_campaign_id, p_contact_id, p_session_id,
    p_mensagem, p_waha_message_id, p_tentativas
  );

  -- Status que chegou antes da confirmação (PK message_id, status).
  IF EXISTS (
    SELECT 1 FROM wacrm.dispatch_status_receipts
    WHERE message_id = p_waha_message_id
  ) THEN
    BEGIN
      PERFORM wacrm.replay_dispatch_receipts(p_waha_message_id);
    EXCEPTION WHEN OTHERS THEN
      -- Não desfaz a confirmação: o reconcile do cron reaplica depois.
      RAISE WARNING 'replay_dispatch_receipts(%) falhou: %', p_waha_message_id, SQLERRM;
    END;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.confirm_dispatch_item_sent(uuid, uuid, uuid, uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.confirm_dispatch_item_sent(uuid, uuid, uuid, uuid, text, text, integer)
  TO service_role;

-- ---------- 6) blacklist em lote (revalidação por tick) ----------
-- Lista única da instância (sem filtro de conta), igual à checagem por
-- envio do processQueue e ao loadBlacklistKeySet do startCampaign.
CREATE OR REPLACE FUNCTION wacrm.blacklisted_phone_keys(p_keys text[])
RETURNS TABLE(key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT wacrm.phone_key(b.telefone)
  FROM wacrm.blacklist b
  WHERE wacrm.phone_key(b.telefone) = ANY(p_keys);
$$;

REVOKE ALL ON FUNCTION wacrm.blacklisted_phone_keys(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.blacklisted_phone_keys(text[]) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
