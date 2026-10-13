-- ============================================================
-- 327_revoke_broadcast_counters.sql   (revisão de segurança 13/10, item 19 — RLS fase 3, item 2 do Sextante)
--
-- public._bcast_bump(uuid,text,int) e public.recompute_broadcast_counts(uuid) são SECURITY DEFINER (005/003) e o Postgres concede EXECUTE a PUBLIC por padrão:
-- qualquer usuário logado (ou anon) podia chamá-las pelo PostgREST (/rpc) e alterar os contadores de QUALQUER broadcast, sem checagem de conta.
-- O único chamador legítimo é o trigger broadcast_recipient_aggregate_trigger, que também é SECURITY DEFINER (roda como dono) ⇒ não precisa de EXECUTE do chamador.
-- O código (src/) não chama nenhuma das duas. Mantém EXECUTE só para service_role (manutenção manual: "SELECT recompute_broadcast_counts(...)" como postgres continua valendo).
-- Procura a função por NOME em pg_proc (assinatura/schema podem variar no banco vivo); o que não existir é ignorado.
--
-- PRÉ-CHECK:  SELECT n.nspname, p.proname, p.prosecdef, pg_get_function_identity_arguments(p.oid), p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname IN ('_bcast_bump','recompute_broadcast_counts');
-- VERIFICAÇÃO: SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname IN ('_bcast_bump','recompute_broadcast_counts');   -- tudo false
--              e inserir/atualizar um broadcast_recipient pelo app: os contadores do broadcast continuam subindo (o trigger é definer).
-- ORDEM: antes ou depois do deploy (o app não usa estas funções). Idempotente.
-- ROLLBACK:   DO $$ DECLARE f record; BEGIN FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.proname IN ('_bcast_bump','recompute_broadcast_counts') AND p.pronamespace = 'public'::regnamespace LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f.sig); END LOOP; END $$;
--             DELETE FROM wacrm.schema_migrations WHERE version = '327_revoke_broadcast_counters';
-- ============================================================

BEGIN;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.proname IN ('_bcast_bump', 'recompute_broadcast_counts')
      AND p.pronamespace IN ('public'::regnamespace, 'wacrm'::regnamespace)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('327_revoke_broadcast_counters') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
