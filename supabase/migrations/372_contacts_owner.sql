-- ============================================================
-- 372_contacts_owner.sql   (API pública Onda 2 — carteira fixa: atendente-dono do contato)
--
-- O QUE FAZ: wacrm.contacts.owner_user_id (nullable) = o atendente "dono" do contato (carteira fixa). FASE 1 (decisão do dono 15/10): só cadastro —
--   PUT/DELETE /api/v1/contacts/{id}/owner gravam, GET /contacts mostra, e POST /conversations (API) usa o dono quando não vem atendente nem equipe
--   (se ele estiver ativo e fora de pausa). A distribuição AUTOMÁTICA (campanha, cliente, fluxo) NÃO muda nesta fase: preferir o dono ali é a fase 2 e
--   depende do aval do dono. ON DELETE SET NULL: usuário removido solta o contato da carteira.
--   O índice parcial fica em 372b (CONCURRENTLY: contacts é tabela grande e não pode travar escrita).
-- COMPATIBILIDADE: sem esta migration as rotas de carteira respondem 503 e o resto da API segue (o dono só é lido quando a coluna existe).
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.contacts');                                                                              -- não nulo
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='contacts' AND column_name='owner_user_id';  -- 0 linhas na 1ª vez
-- VERIFICAÇÃO (depois): SELECT owner_user_id FROM wacrm.contacts LIMIT 1;   -- coluna existe (NULL)
-- ORDEM: antes ou depois do deploy; antes da 372b. Idempotente. (ADD COLUMN nullable sem default: instantâneo, não reescreve a tabela.)
-- ROLLBACK:
--   BEGIN;
--   DROP INDEX IF EXISTS wacrm.idx_contacts_owner;     -- se a 372b já foi aplicada (fora de transação: DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_contacts_owner;)
--   ALTER TABLE wacrm.contacts DROP COLUMN IF EXISTS owner_user_id;
--   DELETE FROM wacrm.schema_migrations WHERE version = '372_contacts_owner';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '372: falta wacrm.contacts — confira o schema vivo';
  END IF;
END $$;

ALTER TABLE wacrm.contacts ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('372_contacts_owner') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
