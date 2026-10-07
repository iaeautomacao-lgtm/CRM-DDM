-- ============================================================
-- 172_dispatch_status_precedence.sql
--
-- Status da Meta fora de ordem: a Meta pode mandar `failed` (ex.: 131026,
-- "Message undeliverable") E `delivered`/`read` para o MESMO wamid — a
-- mensagem chegou e foi lida. A ordem de chegada não pode decidir o estado.
--
-- Precedência: sent < delivered < read; `failed` não vale sobre entregue/lido.
--
-- wacrm.apply_dispatch_status (base: EXATAMENTE a da 167):
--  - failed com o item já 'entregue'/'lido' (ou já 'erro'): ignorado — sem
--    erro, sem métrica, sem registrar 131026 (já era assim pelo ramo ELSE da
--    167; mantido e documentado).
--  - delivered/read com o item em 'erro' POR 131026: o item volta para
--    'entregue'/'lido', erro e erro_permanente limpos, métricas recalculadas
--    (wacrm.recalculate_campaign_metrics), a ocorrência de
--    wacrm.dispatch_meta_131026_failures (telefone+campanha) vira
--    'falso_positivo' (mantida para telemetria) e,
--    se com ela o telefone cair abaixo de 3 campanhas, o bloqueio automático
--    é desfeito — SOMENTE se a origem for a regra do 131026 (blacklist
--    bloqueado_por='sistema' E motivo ILIKE '%131026%', gravado pela 166).
--    Bloqueio humano/opt-out/outro motivo nunca é tocado. Erro que não é
--    131026 continua permanente.
--
-- 131026 PROVISÓRIO (falso positivo × erro real): o `failed` assíncrono grava
-- a ocorrência como 'pendente' (coluna status: pendente|confirmado|
-- falso_positivo + confirmed_at) e ela NÃO conta para a regra das 3 campanhas.
-- Vira 'confirmado' quando nenhum delivered/read chega na janela
-- (DISPARADOR_131026_CONFIRM_MINUTES, padrão 1440 = 24h: aparelho offline
-- também gera 131026 e a mensagem é entregue quando ele volta, às vezes horas depois) — feito por
-- wacrm.confirm_pending_meta_131026, chamada pelo cron — ou 'falso_positivo'
-- (linha mantida para medir) se delivered/read chegar antes. Erro síncrono no
-- AGUARDANDO CONFIRMAÇÃO: enquanto pendente o item da fila NÃO vira erro — fica
-- 'enviado' com entrega_pendente_131026=true e erro informativo (não
-- permanente), sem total_erros, sem entrar no auto-pause (só conta
-- status 'erro' permanente) e sem retry (retry_transient_queue_errors só olha
-- status 'erro'), logo nunca há reenvio duplicado. Só ao confirmar vira
-- 'erro' permanente (+ total_erros). delivered/read antes disso: item segue
-- normal, marcador limpo, ocorrência 'falso_positivo'.
-- Erro síncrono no envio (record_meta_131026_failure) segue confirmado na hora. Linhas da 166
-- ficam 'confirmado'. View wacrm.meta_131026_stats = telemetria por dia/campanha.
--
-- PRÉ-CHECK (rodar antes; as 3 consultas devem devolver valor não nulo):
--   SELECT to_regclass('wacrm.dispatch_meta_131026_failures');
--   SELECT to_regprocedure('wacrm.recalculate_campaign_metrics(uuid)');
--   SELECT pg_get_functiondef('wacrm.apply_dispatch_status(text,text,text)'::regprocedure);
-- Se o corpo de produção divergir da 167, replique a diferença aqui.
--
-- ORDEM: pode ser aplicada antes ou depois do deploy do código (independentes).
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.dispatch_meta_131026_failures') IS NULL
     OR to_regprocedure('wacrm.recalculate_campaign_metrics(uuid)') IS NULL
     OR to_regprocedure('wacrm.apply_dispatch_status(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisitos ausentes: aplique 166/167 antes da 172';
  END IF;
END $$;

-- ---------- 131026 provisório: pendente → confirmado | falso_positivo ----------
-- Linhas existentes (166) já valiam como ocorrência: ficam 'confirmado'.
ALTER TABLE wacrm.dispatch_meta_131026_failures
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmado',
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS queue_id uuid;

-- Item 'enviado' aguardando confirmação de entrega (131026 provisório).
ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS entrega_pendente_131026 boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dispatch_meta_131026_failures_status_check'
      AND conrelid = 'wacrm.dispatch_meta_131026_failures'::regclass
  ) THEN
    ALTER TABLE wacrm.dispatch_meta_131026_failures
      ADD CONSTRAINT dispatch_meta_131026_failures_status_check
      CHECK (status IN ('pendente', 'confirmado', 'falso_positivo'));
  END IF;
END $$;

UPDATE wacrm.dispatch_meta_131026_failures
SET confirmed_at = created_at
WHERE status = 'confirmado' AND confirmed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_meta_131026_pending
  ON wacrm.dispatch_meta_131026_failures(created_at)
  WHERE status = 'pendente';

-- Mesma normalização de telefone da 166.
CREATE OR REPLACE FUNCTION wacrm.meta_131026_phone(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN d = '' THEN NULL
    WHEN left(d, 2) = '55' AND length(d) >= 12 THEN '+' || d
    ELSE '+55' || d
  END
  FROM (SELECT pg_catalog.regexp_replace(COALESCE(p_raw, ''), '\D', '', 'g') AS d) x;
$$;

-- Regra das 3 campanhas: só conta 'confirmado'. Chamar com o lock do telefone.
CREATE OR REPLACE FUNCTION wacrm.meta_131026_apply_rule(
  p_account_id uuid,
  p_telefone text,
  p_campaign_id uuid
)
RETURNS TABLE(campaign_count integer, blacklisted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_blacklisted boolean := false;
BEGIN
  SELECT count(*)::integer INTO v_count
  FROM wacrm.dispatch_meta_131026_failures
  WHERE account_id = p_account_id
    AND telefone = p_telefone
    AND status = 'confirmado';

  IF v_count >= 3 THEN
    INSERT INTO wacrm.blacklist(
      telefone, account_id, motivo, campaign_id, bloqueado_por, data_bloqueio
    )
    VALUES(
      p_telefone,
      p_account_id,
      'Meta: 131026 em 3 campanhas diferentes — bloqueio definitivo',
      p_campaign_id,
      'sistema',
      now()
    )
    ON CONFLICT (telefone) DO NOTHING;

    SELECT EXISTS(
      SELECT 1 FROM wacrm.blacklist
      WHERE telefone = p_telefone AND account_id = p_account_id
    ) INTO v_blacklisted;
  END IF;

  RETURN QUERY SELECT v_count, v_blacklisted;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.meta_131026_apply_rule(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.meta_131026_apply_rule(uuid, text, uuid)
  TO service_role;

-- Ocorrência CONFIRMADA na hora (erro síncrono no envio: não há wamid para
-- chegar um read depois). Mesma assinatura e retorno da 166.
CREATE OR REPLACE FUNCTION wacrm.record_meta_131026_failure(
  p_account_id uuid,
  p_telefone text,
  p_campaign_id uuid
)
RETURNS TABLE(campaign_count integer, blacklisted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_phone text := wacrm.meta_131026_phone(p_telefone);
BEGIN
  IF p_account_id IS NULL OR p_campaign_id IS NULL OR v_phone IS NULL THEN
    RETURN QUERY SELECT 0, false;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text || ':' || v_phone, 0)
  );

  INSERT INTO wacrm.dispatch_meta_131026_failures(
    account_id, telefone, campaign_id, status, confirmed_at
  )
  VALUES(p_account_id, v_phone, p_campaign_id, 'confirmado', now())
  ON CONFLICT (account_id, telefone, campaign_id)
  DO UPDATE SET status = 'confirmado', confirmed_at = now()
  WHERE wacrm.dispatch_meta_131026_failures.status <> 'confirmado';

  RETURN QUERY SELECT * FROM wacrm.meta_131026_apply_rule(p_account_id, v_phone, p_campaign_id);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.record_meta_131026_failure(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.record_meta_131026_failure(uuid, text, uuid)
  TO service_role;

-- Ocorrência PENDENTE (failed assíncrono do webhook): não conta na regra
-- até a janela de confirmação passar sem delivered/read.
CREATE OR REPLACE FUNCTION wacrm.record_meta_131026_pending(
  p_account_id uuid,
  p_telefone text,
  p_campaign_id uuid,
  p_queue_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_phone text := wacrm.meta_131026_phone(p_telefone);
BEGIN
  IF p_account_id IS NULL OR p_campaign_id IS NULL OR v_phone IS NULL THEN RETURN; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text || ':' || v_phone, 0)
  );

  -- Já confirmada/falso positivo para essa campanha: não reabre.
  INSERT INTO wacrm.dispatch_meta_131026_failures(
    account_id, telefone, campaign_id, status, queue_id
  )
  VALUES(p_account_id, v_phone, p_campaign_id, 'pendente', p_queue_id)
  ON CONFLICT (account_id, telefone, campaign_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.record_meta_131026_pending(uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.record_meta_131026_pending(uuid, text, uuid, uuid)
  TO service_role;

-- Cron: confirma as pendentes mais velhas que a janela (padrão 24h) e aplica a
-- regra. Devolve quantas confirmou. O cron chama com lock próprio e só se sobrar tempo.
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

REVOKE ALL ON FUNCTION wacrm.confirm_pending_meta_131026(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.confirm_pending_meta_131026(integer, integer)
  TO service_role;

-- Telemetria: por dia e por campanha.
CREATE OR REPLACE VIEW wacrm.meta_131026_stats AS
SELECT
  (f.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  f.campaign_id,
  count(*) FILTER (WHERE f.status = 'pendente')::integer AS pendentes,
  count(*) FILTER (WHERE f.status = 'confirmado')::integer AS confirmados,
  count(*) FILTER (WHERE f.status = 'falso_positivo')::integer AS falsos_positivos
FROM wacrm.dispatch_meta_131026_failures f
GROUP BY 1, 2;

REVOKE ALL ON wacrm.meta_131026_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.meta_131026_stats TO service_role;

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
  v_digits text;
  v_recovered boolean := false;
  v_pending boolean := false;
  v_false_positive boolean := false;
  v_rows integer;
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
  ELSIF p_status = 'failed' AND v_item.status = 'enviado'
        AND COALESCE(p_error, '') ILIKE '%131026%' THEN
    -- 131026 é provisório (aparelho offline também gera): o item continua
    -- 'enviado', só marcado como aguardando confirmação.
    IF v_item.entrega_pendente_131026 THEN
      DELETE FROM wacrm.dispatch_status_receipts
      WHERE message_id = p_message_id AND status = p_status;
      RETURN false;
    END IF;
    v_next := 'enviado';
    v_pending := true;
  ELSIF p_status = 'failed' AND v_item.status = 'enviado' THEN
    v_next := 'erro';
  ELSIF p_status IN ('delivered', 'read')
        AND v_item.status = 'erro'
        AND COALESCE(v_item.erro, '') ILIKE '%131026%' THEN
    -- 131026 seguido de entregue/lido para o mesmo wamid: a mensagem chegou.
    v_next := CASE WHEN p_status = 'read' THEN 'lido' ELSE 'entregue' END;
    v_recovered := true;
  ELSE
    -- Transição velha/duplicada, ou failed depois de entregue/lido/erro:
    -- descarta (inclusive recibo guardado antes).
    DELETE FROM wacrm.dispatch_status_receipts
    WHERE message_id = p_message_id AND status = p_status;
    RETURN false;
  END IF;

  v_false_positive := v_recovered
    OR (v_item.entrega_pendente_131026 AND v_next IN ('entregue', 'lido'));

  UPDATE wacrm.disp_message_queue
  SET status = v_next,
      updated_at = clock_timestamp(),
      erro = CASE
        WHEN v_next = 'erro'
        THEN COALESCE(p_error, 'Falha de entrega; revisar antes de reenviar')
        WHEN v_pending THEN 'Aguardando confirmação de entrega (Meta 131026)'
        WHEN v_false_positive THEN NULL
        ELSE erro
      END,
      erro_permanente = CASE
        WHEN v_next = 'erro' THEN true
        WHEN v_recovered THEN false
        ELSE erro_permanente
      END,
      entrega_pendente_131026 = CASE
        WHEN v_pending THEN true
        WHEN v_next IN ('entregue', 'lido') THEN false
        ELSE entrega_pendente_131026
      END
  WHERE id = v_item.id
    AND waha_message_id = p_message_id;

  IF v_recovered THEN
    -- Item já estava em 'erro' por 131026 (antes da 172): sai de total_erros e
    -- entra em entregues/lidos (recalcula pela fila — mesma função da 112).
    PERFORM wacrm.recalculate_campaign_metrics(v_item.campaign_id);
  ELSIF v_pending THEN
    -- Provisório: não é falha (sem total_erros); só registra a ocorrência.
    SELECT c.phone INTO v_phone
    FROM wacrm.contacts c
    WHERE c.id = v_item.contact_id;

    IF v_item.account_id IS NOT NULL
       AND v_item.campaign_id IS NOT NULL
       AND COALESCE(v_phone, '') <> '' THEN
      PERFORM wacrm.record_meta_131026_pending(
        v_item.account_id, v_phone, v_item.campaign_id, v_item.id
      );
    END IF;
  ELSE
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
  END IF;

  IF v_false_positive
     AND v_item.account_id IS NOT NULL
     AND v_item.campaign_id IS NOT NULL
     AND v_item.contact_id IS NOT NULL THEN
    SELECT c.phone INTO v_phone
    FROM wacrm.contacts c
    WHERE c.id = v_item.contact_id;

    v_digits := pg_catalog.regexp_replace(COALESCE(v_phone, ''), '\D', '', 'g');

    IF v_digits <> '' THEN
      -- Mesma normalização e mesmo lock de record_meta_131026_failure (166).
      v_phone := wacrm.meta_131026_phone(v_phone);

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_item.account_id::text || ':' || v_phone, 0)
      );

      -- Falso positivo: a linha é mantida (não apagar) para medir.
      UPDATE wacrm.dispatch_meta_131026_failures
      SET status = 'falso_positivo', confirmed_at = now()
      WHERE account_id = v_item.account_id
        AND telefone = v_phone
        AND campaign_id = v_item.campaign_id
        AND status IN ('pendente', 'confirmado');
      GET DIAGNOSTICS v_rows = ROW_COUNT;

      IF v_rows > 0 AND to_regclass('wacrm.system_logs') IS NOT NULL THEN
        EXECUTE 'INSERT INTO wacrm.system_logs(account_id, level, source, event, message, payload)
                 VALUES ($1, ''info'', ''disparador'', ''meta_131026_false_positive'', $2, $3)'
        USING v_item.account_id,
              'Meta 131026 seguido de ' || p_status || ': falso positivo',
              pg_catalog.jsonb_build_object(
                'campaign_id', v_item.campaign_id,
                'queue_id', v_item.id,
                'message_id', p_message_id,
                'status', p_status
              );
      END IF;

      -- Bloqueio automático só cai se a regra das 3 campanhas (só
      -- 'confirmado') deixou de valer E a origem é essa regra. Nunca remove
      -- bloqueio humano/opt-out.
      IF (
        SELECT count(*)
        FROM wacrm.dispatch_meta_131026_failures f
        WHERE f.account_id = v_item.account_id
          AND f.telefone = v_phone
          AND f.status = 'confirmado'
      ) < 3 THEN
        DELETE FROM wacrm.blacklist b
        WHERE b.telefone = v_phone
          AND b.account_id = v_item.account_id
          AND b.bloqueado_por = 'sistema'
          AND b.motivo ILIKE '%131026%';
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

COMMIT;

NOTIFY pgrst, 'reload schema';
