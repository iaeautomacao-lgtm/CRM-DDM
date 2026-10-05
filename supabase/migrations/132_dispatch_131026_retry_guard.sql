-- 132 — Meta 131026 is terminal for automatic dispatch.
--
-- Before this migration, processQueue auto-blacklisted a 131026 destination
-- but retry_transient_queue_errors still treated the queue row as transient
-- (erro_permanente=false). That could move an already blocked destination
-- back to status='agendado' and leave campaigns with misleading "A enviar"
-- counts when the cron stopped before the retry.
--
-- This migration:
-- 1) excludes Meta 131026 and current blacklist hits from automatic retry;
-- 2) restricts the internal retry RPC to service_role;
-- 3) reconciles already-pending 131026 rows as terminal 'bloqueado';
-- 4) recalculates metrics for campaigns changed by the reconciliation.
BEGIN;

CREATE OR REPLACE FUNCTION wacrm.retry_transient_queue_errors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE wacrm.disp_message_queue q
  SET
    status = 'agendado',
    scheduled_at = clock_timestamp()
      + (q.tentativas * q.tentativas * interval '1 minute'),
    updated_at = clock_timestamp()
  WHERE q.status = 'erro'
    AND COALESCE(q.erro_permanente, false) = false
    AND q.tentativas < 5
    AND COALESCE(q.sent_at, q.created_at)
        < clock_timestamp() - interval '5 minutes'
    -- 131026 is already treated as a blacklist-worthy destination by the
    -- application, therefore retrying it is contradictory.
    AND COALESCE(q.erro, '') NOT ILIKE '%131026%'
    AND EXISTS (
      SELECT 1
      FROM wacrm.campaigns c
      WHERE c.id = q.campaign_id
        AND c.status = 'em_execucao'
    )
    -- Do not revive any other transient-looking row after its current
    -- destination has entered the account blacklist.
    AND NOT EXISTS (
      SELECT 1
      FROM wacrm.blacklist b
      WHERE (b.account_id = q.account_id OR b.account_id IS NULL)
        AND regexp_replace(COALESCE(b.telefone, ''), '\\D', '', 'g')
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
              '\\D',
              '',
              'g'
            )
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.retry_transient_queue_errors()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.retry_transient_queue_errors()
  TO service_role;

DO $$
DECLARE
  v_campaign_id uuid;
BEGIN
  FOR v_campaign_id IN
    SELECT DISTINCT q.campaign_id
    FROM wacrm.disp_message_queue q
    WHERE q.campaign_id IS NOT NULL
      AND q.status IN ('agendado', 'erro')
      AND COALESCE(q.erro_permanente, false) = false
      AND COALESCE(q.erro, '') ILIKE '%131026%'
  LOOP
    UPDATE wacrm.disp_message_queue
    SET
      status = 'bloqueado',
      erro_permanente = true,
      updated_at = clock_timestamp()
    WHERE campaign_id = v_campaign_id
      AND status IN ('agendado', 'erro')
      AND COALESCE(erro_permanente, false) = false
      AND COALESCE(erro, '') ILIKE '%131026%';

    PERFORM wacrm.recalculate_campaign_metrics(v_campaign_id);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
