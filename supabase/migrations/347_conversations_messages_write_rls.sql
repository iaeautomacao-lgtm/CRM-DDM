-- ============================================================
-- 347_conversations_messages_write_rls.sql   (revisão de segurança 13/10, item 8 — RLS fase 3, escrita: conversas e mensagens)
--
-- messages:       a policy messages_modify (FOR ALL, papel >= agent, 017) deixava qualquer operador gravar/alterar/apagar MENSAGENS direto pelo PostgREST (falsificar histórico).
--                 O navegador NÃO grava em messages (confirmado em src/: envio e recebimento passam por /api/whatsapp/send, webhooks e fluxos, todos com service_role).
--                 Troca: DROP da policy + REVOKE INSERT/UPDATE/DELETE de authenticated e anon. A leitura continua pela messages_select (membro da conta + RLS de conversations).
-- conversations:  insert/update eram "papel >= agent" (017); passam a "membro da conta + (inbox.reply OU inbox.transfer OU inbox.close)" — as três são de agent+ nos papéis de sistema,
--                 e são as ações que as telas fazem (message-thread.tsx: assumir, transferir, encerrar; contact-detail-view: abrir conversa). Nada muda para os papéis de sistema.
--                 delete continua admin+ (108) E exige inbox.delete_conversation: o papel personalizado precisa da chave e do nível; admin e proprietário seguem iguais.
-- Servidor (service_role) não passa por RLS: webhooks, motor de fluxos, IA e disparador seguem iguais.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false) → ABORTA, sem alterar nada, se houver perfil sem role_id.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                                  -- 0 (senão aborta)
--             SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('conversations','messages') ORDER BY 1,2;
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('inbox.reply','inbox.transfer','inbox.close','inbox.delete_conversation');   -- 4 linhas
-- VERIFICAÇÃO: como operador (JWT): assumir/transferir/encerrar conversa pelo CRM funciona; INSERT em wacrm.messages pelo PostgREST → "permission denied". Enviar mensagem pelo CRM continua funcionando.
-- ORDEM: antes ou depois do deploy (o app não grava messages pelo navegador). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS conversations_insert ON wacrm.conversations;
--             DROP POLICY IF EXISTS conversations_update ON wacrm.conversations;
--             DROP POLICY IF EXISTS conversations_delete ON wacrm.conversations;
--             CREATE POLICY conversations_insert ON wacrm.conversations FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY conversations_update ON wacrm.conversations FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY conversations_delete ON wacrm.conversations FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
--             GRANT INSERT, UPDATE, DELETE ON wacrm.messages TO authenticated;
--             DROP POLICY IF EXISTS messages_modify ON wacrm.messages;
--             CREATE POLICY messages_modify ON wacrm.messages FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.conversations c WHERE c.id = messages.conversation_id AND wacrm.is_account_member(c.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.conversations c WHERE c.id = messages.conversation_id AND wacrm.is_account_member(c.account_id, 'agent')));
--             DELETE FROM wacrm.schema_migrations WHERE version = '347_conversations_messages_write_rls';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '347: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('inbox.reply', 'inbox.transfer', 'inbox.close', 'inbox.delete_conversation')) <> 4 THEN
    RAISE EXCEPTION '347: faltam chaves no catálogo (inbox.reply/transfer/close/delete_conversation — migration 240)';
  END IF;
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.messages') IS NULL THEN
    RAISE EXCEPTION '347: falta wacrm.conversations ou wacrm.messages — confira o schema vivo';
  END IF;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '347: % perfil(is) sem role_id perderiam a escrita (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

-- ---- conversations -----------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS conversations_insert ON wacrm.conversations;
DROP POLICY IF EXISTS conversations_update ON wacrm.conversations;
DROP POLICY IF EXISTS conversations_delete ON wacrm.conversations;
CREATE POLICY conversations_insert ON wacrm.conversations FOR INSERT WITH CHECK (
  wacrm.is_account_member(account_id)
  AND ((SELECT wacrm.has_perm('inbox.reply')) OR (SELECT wacrm.has_perm('inbox.transfer')) OR (SELECT wacrm.has_perm('inbox.close')))
);
CREATE POLICY conversations_update ON wacrm.conversations FOR UPDATE USING (
  wacrm.is_account_member(account_id)
  AND ((SELECT wacrm.has_perm('inbox.reply')) OR (SELECT wacrm.has_perm('inbox.transfer')) OR (SELECT wacrm.has_perm('inbox.close')))
) WITH CHECK (
  wacrm.is_account_member(account_id)
  AND ((SELECT wacrm.has_perm('inbox.reply')) OR (SELECT wacrm.has_perm('inbox.transfer')) OR (SELECT wacrm.has_perm('inbox.close')))
);
CREATE POLICY conversations_delete ON wacrm.conversations FOR DELETE USING (
  wacrm.is_account_member(account_id, 'admin') AND (SELECT wacrm.has_perm('inbox.delete_conversation'))
);

-- ---- messages: o navegador não grava; só leitura -----------------------------------------------------------------------------
DROP POLICY IF EXISTS messages_modify ON wacrm.messages;
REVOKE INSERT, UPDATE, DELETE ON wacrm.messages FROM authenticated, anon;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('347_conversations_messages_write_rls') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
