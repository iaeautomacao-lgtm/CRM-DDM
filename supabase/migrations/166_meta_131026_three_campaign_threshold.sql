-- 166_meta_131026_three_campaign_threshold.sql
--
-- A Meta 131026 deixa de bloquear um número globalmente na primeira
-- ocorrência. A regra passa a ser: blacklist definitiva somente depois de
-- 131026 em 3 campanhas distintas para o mesmo telefone.
--
-- Repetições dentro da mesma campanha não contam duas vezes.
-- O erro continua permanente para o item/campanha atual (sem retry automático).
BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_meta_131026_failures (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  telefone text NOT NULL,
  campaign_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_meta_131026_failures_unique_campaign
    UNIQUE (account_id, telefone, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_meta_131026_account_phone
  ON wacrm.dispatch_meta_131026_failures(account_id, telefone);

ALTER TABLE wacrm.dispatch_meta_131026_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_meta_131026_failures
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.dispatch_meta_131026_failures TO service_role;

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
  v_digits text;
  v_phone text;
  v_count integer;
  v_blacklisted boolean := false;
BEGIN
  IF p_account_id IS NULL OR p_campaign_id IS NULL OR COALESCE(p_telefone, '') = '' THEN
    RETURN QUERY SELECT 0, false;
    RETURN;
  END IF;

  v_digits := regexp_replace(p_telefone, '\D', '', 'g');
  IF v_digits = '' THEN
    RETURN QUERY SELECT 0, false;
    RETURN;
  END IF;

  -- Mesma convenção usada pelo CRM para números brasileiros.
  v_phone := CASE
    WHEN left(v_digits, 2) = '55' AND length(v_digits) >= 12
      THEN '+' || v_digits
    ELSE '+55' || v_digits
  END;

  -- Serializa ocorrências concorrentes do mesmo telefone. Sem este lock,
  -- duas campanhas que falhem ao mesmo tempo poderiam ambas enxergar
  -- count=2 e a terceira ocorrência só bloquear no próximo evento.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text || ':' || v_phone, 0)
  );

  INSERT INTO wacrm.dispatch_meta_131026_failures(
    account_id, telefone, campaign_id
  )
  VALUES(p_account_id, v_phone, p_campaign_id)
  ON CONFLICT (account_id, telefone, campaign_id) DO NOTHING;

  SELECT count(*)::integer
  INTO v_count
  FROM wacrm.dispatch_meta_131026_failures
  WHERE account_id = p_account_id
    AND telefone = v_phone;

  IF v_count >= 3 THEN
    INSERT INTO wacrm.blacklist(
      telefone,
      account_id,
      motivo,
      campaign_id,
      bloqueado_por,
      data_bloqueio
    )
    VALUES(
      v_phone,
      p_account_id,
      'Meta: 131026 em 3 campanhas diferentes — bloqueio definitivo',
      p_campaign_id,
      'sistema',
      now()
    )
    ON CONFLICT (telefone) DO NOTHING;

    SELECT EXISTS(
      SELECT 1
      FROM wacrm.blacklist
      WHERE telefone = v_phone
        AND account_id = p_account_id
    )
    INTO v_blacklisted;
  END IF;

  RETURN QUERY SELECT v_count, v_blacklisted;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.record_meta_131026_failure(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.record_meta_131026_failure(uuid, text, uuid)
  TO service_role;

-- Backfill das ocorrências históricas conhecidas pela fila.
INSERT INTO wacrm.dispatch_meta_131026_failures(account_id, telefone, campaign_id)
SELECT DISTINCT
  q.account_id,
  CASE
    WHEN left(regexp_replace(c.phone, '\D', '', 'g'), 2) = '55'
      AND length(regexp_replace(c.phone, '\D', '', 'g')) >= 12
      THEN '+' || regexp_replace(c.phone, '\D', '', 'g')
    ELSE '+55' || regexp_replace(c.phone, '\D', '', 'g')
  END,
  q.campaign_id
FROM wacrm.disp_message_queue q
JOIN wacrm.contacts c ON c.id = q.contact_id
WHERE q.account_id IS NOT NULL
  AND q.campaign_id IS NOT NULL
  AND COALESCE(c.phone, '') <> ''
  AND COALESCE(q.erro, '') ILIKE '%131026%'
ON CONFLICT (account_id, telefone, campaign_id) DO NOTHING;

-- Preserva pelo menos a campanha de origem das entradas automáticas legadas.
INSERT INTO wacrm.dispatch_meta_131026_failures(account_id, telefone, campaign_id)
SELECT DISTINCT
  b.account_id,
  CASE
    WHEN left(regexp_replace(b.telefone, '\D', '', 'g'), 2) = '55'
      AND length(regexp_replace(b.telefone, '\D', '', 'g')) >= 12
      THEN '+' || regexp_replace(b.telefone, '\D', '', 'g')
    ELSE '+55' || regexp_replace(b.telefone, '\D', '', 'g')
  END,
  b.campaign_id
FROM wacrm.blacklist b
WHERE b.account_id IS NOT NULL
  AND b.campaign_id IS NOT NULL
  AND b.bloqueado_por = 'sistema'
  AND b.motivo ILIKE '%131026%'
ON CONFLICT (account_id, telefone, campaign_id) DO NOTHING;

-- Telefones históricos que já atingiram 3 campanhas distintas passam a
-- cumprir a nova regra imediatamente, mesmo que o 131026 tenha chegado pelo
-- webhook assíncrono e por isso nunca tenha criado blacklist na regra antiga.
INSERT INTO wacrm.blacklist(
  telefone,
  account_id,
  motivo,
  campaign_id,
  bloqueado_por,
  data_bloqueio
)
SELECT
  f.telefone,
  f.account_id,
  'Meta: 131026 em 3 campanhas diferentes — bloqueio definitivo',
  max(f.campaign_id::text)::uuid,
  'sistema',
  now()
FROM wacrm.dispatch_meta_131026_failures f
GROUP BY f.account_id, f.telefone
HAVING count(*) >= 3
ON CONFLICT (telefone) DO NOTHING;

-- Entradas legadas com menos de 3 campanhas deixam de bloquear campanhas
-- futuras; continuam registradas na tabela de ocorrências acima.
DELETE FROM wacrm.blacklist b
WHERE b.bloqueado_por = 'sistema'
  AND b.motivo ILIKE '%131026%'
  AND (
    SELECT count(*)
    FROM wacrm.dispatch_meta_131026_failures f
    WHERE f.account_id = b.account_id
      AND f.telefone = CASE
        WHEN left(regexp_replace(b.telefone, '\D', '', 'g'), 2) = '55'
          AND length(regexp_replace(b.telefone, '\D', '', 'g')) >= 12
          THEN '+' || regexp_replace(b.telefone, '\D', '', 'g')
        ELSE '+55' || regexp_replace(b.telefone, '\D', '', 'g')
      END
  ) < 3;

-- As que já atingiram 3+ campanhas ganham motivo definitivo.
UPDATE wacrm.blacklist b
SET motivo = 'Meta: 131026 em 3 campanhas diferentes — bloqueio definitivo',
    bloqueado_por = 'sistema'
WHERE b.bloqueado_por = 'sistema'
  AND b.motivo ILIKE '%131026%'
  AND (
    SELECT count(*)
    FROM wacrm.dispatch_meta_131026_failures f
    WHERE f.account_id = b.account_id
      AND f.telefone = CASE
        WHEN left(regexp_replace(b.telefone, '\D', '', 'g'), 2) = '55'
          AND length(regexp_replace(b.telefone, '\D', '', 'g')) >= 12
          THEN '+' || regexp_replace(b.telefone, '\D', '', 'g')
        ELSE '+55' || regexp_replace(b.telefone, '\D', '', 'g')
      END
  ) >= 3;

-- A falha assíncrona chega pelo webhook. Quando apply_dispatch_status
-- transforma o item em erro, registra a campanha no mesmo contador.
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

  DELETE FROM wacrm.dispatch_status_receipts
  WHERE message_id = p_message_id AND status = p_status;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.apply_dispatch_status(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.apply_dispatch_status(text, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
