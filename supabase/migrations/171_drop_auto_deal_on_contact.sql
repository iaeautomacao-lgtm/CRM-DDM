-- ============================================================
-- 171_drop_auto_deal_on_contact.sql
--
-- Decisão de produto (07/10/2026): o CRM trabalha só com CONTATOS; não deve
-- criar um "negócio" (deal) automaticamente para cada contato novo.
--
-- A migration 028 criou o trigger trigger_create_deal_for_new_contact
-- (AFTER INSERT em wacrm.contacts), que para cada contato novo fazia
-- 3 leituras (pipelines, pipeline_stages, deals) + 1 INSERT em deals.
-- Numa importação de 100 mil contatos isso gerava 100 mil negócios e era a
-- maior parte do tempo de gravação.
--
-- Esta migration só REMOVE O TRIGGER. Não apaga a função (fica inerte) nem
-- os negócios que já existem — limpar os negócios antigos é uma decisão
-- separada (ver consulta abaixo).
--
-- Conferir antes:
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'wacrm.contacts'::regclass AND NOT tgisinternal;
-- Quantos negócios foram criados automaticamente (só para informação):
--   SELECT count(*) FROM wacrm.deals;
--
-- Idempotente. Pode ser aplicada antes ou depois do deploy (o código do app
-- não depende do trigger).
-- ============================================================

BEGIN;

DROP TRIGGER IF EXISTS trigger_create_deal_for_new_contact ON wacrm.contacts;

COMMIT;
