-- ============================================================
-- 329_revoke_anon_wacrm.sql   (revisão de segurança 13/10, item 8 — RLS fase 3, item 4 do Sextante)
--
-- A migration 027 fez GRANT ALL em TODAS as tabelas, sequências e funções do schema wacrm para anon (visitante sem login), e esse privilégio ficou em tudo que existia na época.
-- Hoje o que protege é só a RLS (sem policy para anon) — uma tabela criada sem RLS, ou uma função SECURITY DEFINER esquecida, ficaria aberta para a internet.
-- Confirmado no código: o anon (chave pública, sem sessão) só é usado para o fluxo de auth (login/2FA/reset: endpoints /auth, não PostgREST) e para peek_invitation
-- (public.peek_invitation, com GRANT próprio na 019; a rota usa o cliente do servidor com schema wacrm — se o banco vivo tiver wacrm.peek_invitation, o EXECUTE dela é
-- devolvido ao anon abaixo). O webchat público e as demais rotas sem login usam service_role. Nenhum fluxo do app lê ou grava tabela do wacrm como anon.
--
-- O que faz: REVOKE ALL de anon em TODAS as tabelas e sequências do schema wacrm; nas funções, tira de PUBLIC+anon e devolve o EXECUTE explícito a authenticated/service_role onde já tinham; privilégios padrão futuros de tabelas/sequências/funções do anon revogados
-- (função NOVA ainda nasce executável por PUBLIC — padrão do Postgres —, então cada migration nova de RPC deve fazer REVOKE ALL ... FROM PUBLIC, anon);
-- devolve EXECUTE de anon só a wacrm.peek_invitation(*) quando existir. NÃO mexe em authenticated nem em service_role. NÃO mexe em public.peek_invitation.
--
-- PRÉ-CHECK:  SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'wacrm' AND grantee = 'anon' LIMIT 20;          -- hoje: tudo
--             SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'wacrm'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE') LIMIT 20;
--             SELECT to_regprocedure('wacrm.peek_invitation(text)'), to_regprocedure('public.peek_invitation(text)');
-- VERIFICAÇÃO: as consultas acima voltam vazias (exceto peek_invitation); convite por link (GET /api/invitations/<token>/peek) e login/2FA/reset continuam funcionando.
-- ORDEM: antes ou depois do deploy (o app não depende do anon no wacrm). Idempotente.
-- ROLLBACK:   GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO anon;
--             GRANT ALL ON ALL SEQUENCES IN SCHEMA wacrm TO anon;
--             GRANT ALL ON ALL FUNCTIONS IN SCHEMA wacrm TO PUBLIC, anon;
--             DELETE FROM wacrm.schema_migrations WHERE version = '329_revoke_anon_wacrm';
-- ============================================================

BEGIN;

REVOKE ALL ON ALL TABLES IN SCHEMA wacrm FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA wacrm FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA wacrm REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA wacrm REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA wacrm REVOKE ALL ON FUNCTIONS FROM anon;

-- Funções: o anon também executa por PUBLIC (padrão do Postgres), então tira de PUBLIC e anon e DEVOLVE o EXECUTE explícito a quem tinha (authenticated e/ou service_role) —
-- assim nenhuma chamada atual do app muda. Quem nunca teve (já revogado por migrations antigas como a 133/170) continua sem.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid, p.oid::regprocedure AS sig, p.proname,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_ok,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_ok
    FROM pg_proc p
    WHERE p.pronamespace = 'wacrm'::regnamespace AND p.prokind IN ('f', 'p')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    IF f.auth_ok THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig); END IF;
    IF f.svc_ok THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig); END IF;
    IF f.proname = 'peek_invitation' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', f.sig); END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('329_revoke_anon_wacrm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
