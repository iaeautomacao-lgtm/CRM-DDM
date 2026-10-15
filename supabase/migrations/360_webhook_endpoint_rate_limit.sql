-- ============================================================
-- 360_webhook_endpoint_rate_limit.sql   (API pública Onda 1, bloco B — eventos de campanha e de destinatário)
--
-- PROBLEMA: os eventos por destinatário (recipient.status / recipient.funnel, migrations 361 e 362) podem passar de centenas de milhares
-- de entregas por dia. Sem teto, o drenador entrega o mais rápido que consegue e derruba o ERP do cliente (ou estoura o limite dele).
-- O QUE FAZ: cada endpoint ganha um LIMITE DE ENTREGAS POR MINUTO configurável (`rate_limit_per_minute`, padrão 600 = 10/s, de 1 a 6000).
--   O que passa do limite NÃO se perde: fica `pending` (sem gastar tentativa) e sai quando houver orçamento no minuto seguinte.
--   A janela é deslizante de 60 s e conta as reservas (claims) do endpoint; duas execuções simultâneas do cron podem passar um pouco
--   do limite (é um teto de proteção, não um contador contábil).
--   1. wacrm.webhook_endpoints.rate_limit_per_minute  integer NOT NULL DEFAULT 600 CHECK (1..6000)
--   2. wacrm.webhook_deliveries.last_claimed_at       timestamptz (quando a entrega foi reservada pela última vez) + índice parcial
--   3. wacrm.claim_webhook_deliveries(uuid, integer)  REESCRITA (mesma assinatura e mesmas colunas de retorno): reserva por endpoint,
--      respeitando o orçamento do minuto (limite − reservas dos últimos 60 s). Lease, retry, dead e SKIP LOCKED seguem iguais.
-- COMPATIBILIDADE: sem esta migration o app continua entregando como hoje (a coluna é lida com tolerância) e o limite configurado
--   por /api/v1/webhooks responde 503 explicando que falta a 360.
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.webhook_endpoints'), to_regclass('wacrm.webhook_deliveries');                  -- não nulos (migration 204)
--   SELECT to_regprocedure('wacrm.claim_webhook_deliveries(uuid, integer)');                                -- existe (assinatura real)
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='webhook_endpoints'
--      AND column_name='rate_limit_per_minute';                                                             -- 0 linhas na 1ª vez
--   SELECT count(*) FROM wacrm.webhook_deliveries;   -- se passar de ~1 milhão, crie ANTES o índice abaixo com CONCURRENTLY (fora de transação)
-- VERIFICAÇÃO (depois): SELECT rate_limit_per_minute FROM wacrm.webhook_endpoints LIMIT 1;  -- 600
-- ORDEM: antes ou depois do deploy. Idempotente.
-- ROLLBACK (restaura a função da 204 e remove as colunas):
--   BEGIN;
--   DROP INDEX IF EXISTS wacrm.idx_webhook_deliveries_claimed;
--   -- recriar wacrm.claim_webhook_deliveries(uuid, integer) com o corpo da migration 204 (sem orçamento por endpoint)
--   ALTER TABLE wacrm.webhook_deliveries DROP COLUMN IF EXISTS last_claimed_at;
--   ALTER TABLE wacrm.webhook_endpoints  DROP COLUMN IF EXISTS rate_limit_per_minute;
--   DELETE FROM wacrm.schema_migrations WHERE version = '360_webhook_endpoint_rate_limit';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.webhook_endpoints') IS NULL OR to_regclass('wacrm.webhook_deliveries') IS NULL THEN
    RAISE EXCEPTION '360: faltam wacrm.webhook_endpoints / webhook_deliveries (migration 204) — nada foi alterado';
  END IF;
  IF to_regprocedure('wacrm.claim_webhook_deliveries(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION '360: falta wacrm.claim_webhook_deliveries(uuid, integer) (migration 204) — confira o schema vivo';
  END IF;
END $$;

ALTER TABLE wacrm.webhook_endpoints
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer NOT NULL DEFAULT 600;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_rate_limit_check' AND conrelid = 'wacrm.webhook_endpoints'::regclass) THEN
    ALTER TABLE wacrm.webhook_endpoints
      ADD CONSTRAINT webhook_endpoints_rate_limit_check CHECK (rate_limit_per_minute BETWEEN 1 AND 6000);
  END IF;
END $$;

ALTER TABLE wacrm.webhook_deliveries ADD COLUMN IF NOT EXISTS last_claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_claimed
  ON wacrm.webhook_deliveries (endpoint_id, last_claimed_at DESC) WHERE last_claimed_at IS NOT NULL;

-- Reserva entregas devidas (lease de 120 s) respeitando o limite por minuto de CADA endpoint. Linha `sending` com lease vencido volta à
-- fila; sem tentativas restantes vira `dead`. Mesmos retornos da 204.
CREATE OR REPLACE FUNCTION wacrm.claim_webhook_deliveries(p_owner uuid, p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, account_id uuid, endpoint_id uuid, event text, payload jsonb, attempts integer, url text, secret_enc text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 200));
BEGIN
  UPDATE wacrm.webhook_deliveries d
     SET state = 'dead', dead_at = now(), owner_id = NULL, lease_until = NULL,
         last_error = coalesce(d.last_error, 'Lease vencido sem tentativas restantes')
   WHERE d.state = 'sending' AND d.lease_until < now() AND d.attempts >= 12;

  RETURN QUERY
  WITH eps AS (
    SELECT e.id AS eid,
           greatest(0, e.rate_limit_per_minute - (
             SELECT count(*) FROM wacrm.webhook_deliveries x
              WHERE x.endpoint_id = e.id AND x.last_claimed_at > now() - interval '60 seconds'))::integer AS budget
      FROM wacrm.webhook_endpoints e
     WHERE e.status = 'active'
  ), due AS (
    SELECT l.did
      FROM eps
     CROSS JOIN LATERAL (
       SELECT d.id AS did
         FROM wacrm.webhook_deliveries d
        WHERE d.endpoint_id = eps.eid
          AND ((d.state = 'pending' AND d.next_attempt_at <= now()) OR (d.state = 'sending' AND d.lease_until < now()))
        ORDER BY d.next_attempt_at
        LIMIT least(eps.budget, v_limit)
          FOR UPDATE OF d SKIP LOCKED
     ) l
     LIMIT v_limit
  ), claimed AS (
    UPDATE wacrm.webhook_deliveries d
       SET state = 'sending', owner_id = p_owner, lease_until = now() + interval '120 seconds', attempts = d.attempts + 1,
           last_claimed_at = now()
      FROM due WHERE d.id = due.did
    RETURNING d.id, d.account_id, d.endpoint_id, d.event, d.payload, d.attempts
  )
  SELECT c.id, c.account_id, c.endpoint_id, c.event, c.payload, c.attempts, e.url, e.secret_enc
    FROM claimed c JOIN wacrm.webhook_endpoints e ON e.id = c.endpoint_id;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.claim_webhook_deliveries(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_webhook_deliveries(uuid, integer) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('360_webhook_endpoint_rate_limit') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
