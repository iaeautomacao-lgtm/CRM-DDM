-- ============================================================
-- 333_dispatch_131026_pending_counts.sql   (AUDIT-DISPARADOR D-10 — contagem das 131026 pendentes sem teto silencioso)
--
-- O Monitor mostrava "N mensagens aguardando confirmação (131026)" lendo até 5.000 linhas de dispatch_meta_131026_failures e
-- contando no navegador/servidor: acima de 5.000 o número ficava em 5.000, sem aviso (mesma classe do bug do Dashboard).
-- wacrm.dispatch_131026_pending_counts(p_account_id) devolve a contagem JÁ AGRUPADA por campanha, numa agregação no banco.
-- Só service_role (o snapshot do Monitor usa o cliente admin e filtra pela conta explicitamente).
--
-- COMPATIBILIDADE: sem a função (PGRST202/42883) o Monitor volta à leitura antiga e, se bater nas 5.000 linhas, AVISA que a contagem é
-- parcial ("5.000+"). Pode ser aplicada antes ou depois do deploy.
-- PRÉ-CHECK: SELECT to_regclass('wacrm.dispatch_meta_131026_failures');   -- não nulo
--            SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='dispatch_meta_131026_failures'
--             AND column_name IN ('account_id','campaign_id','status');   -- 3 linhas (status vem da 172)
-- ROLLBACK:  DROP FUNCTION IF EXISTS wacrm.dispatch_131026_pending_counts(uuid);
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.dispatch_meta_131026_failures') IS NULL THEN
    RAISE EXCEPTION '333: falta wacrm.dispatch_meta_131026_failures (migration 166)';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'wacrm' AND table_name = 'dispatch_meta_131026_failures'
         AND column_name IN ('account_id', 'campaign_id', 'status')) < 3 THEN
    RAISE EXCEPTION '333: faltam colunas em dispatch_meta_131026_failures (account_id, campaign_id, status — migration 172)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.dispatch_131026_pending_counts(p_account_id uuid)
RETURNS TABLE (campaign_id uuid, pending bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.campaign_id, count(*)
  FROM wacrm.dispatch_meta_131026_failures f
  WHERE f.account_id = p_account_id AND f.status = 'pendente'
  GROUP BY f.campaign_id;
$$;

REVOKE ALL ON FUNCTION wacrm.dispatch_131026_pending_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.dispatch_131026_pending_counts(uuid) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('333_dispatch_131026_pending_counts') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
