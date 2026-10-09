-- ============================================================
-- 314_contacts_phone_suffix_lookup.sql   (auditoria de backend B-13 — busca de contato por telefone sem varrer a conta)
--
-- PROBLEMA: findExistingContact (src/lib/contacts/dedupe.ts), chamado A CADA mensagem recebida, no POST /api/contacts e
--   no envio da API v1, filtrava `contacts.phone LIKE '%<últimos 8 dígitos>'`. O curinga no início impede índice: varria
--   todos os contatos da conta por mensagem.
-- O QUE FAZ: wacrm.find_contacts_by_phone_suffix(conta, sufixo) — contatos da conta cujos últimos 8 dígitos do telefone
--   (`right(phone_normalized, 8)`; phone_normalized é a coluna gerada da 022, só dígitos) são o sufixo dado. Usa o índice
--   de expressão da 314b. SECURITY INVOKER: respeita o RLS de quem chama (cliente do usuário ou service role), como a
--   consulta que substitui. O app filtra o resultado com phonesMatch, como antes. Teto de 50 linhas.
-- PRÉ-CHECK (rodar ANTES):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'wacrm' AND table_name = 'contacts' AND column_name = 'phone_normalized';   -- 1 linha (022)
--   SELECT to_regprocedure('wacrm.find_contacts_by_phone_suffix(uuid,text)');                          -- NULL na 1ª vez
-- VERIFICAÇÃO:
--   SELECT id FROM wacrm.find_contacts_by_phone_suffix('<account_id>', '<8 dígitos>');
-- ORDEM: antes ou depois do deploy (sem a função, o app usa a consulta antiga). Depois, a 314b (RODAR SOZINHO).
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.find_contacts_by_phone_suffix(uuid, text);
--   DELETE FROM wacrm.schema_migrations WHERE version = '314_contacts_phone_suffix_lookup';
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '314: falta wacrm.contacts';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'contacts' AND column_name = 'phone_normalized'
  ) THEN
    RAISE EXCEPTION '314: falta wacrm.contacts.phone_normalized (migration 022) — confira o schema vivo';
  END IF;
END $$;

-- LANGUAGE sql, STABLE, sem SET: o planejador usa o índice de expressão (a mesma expressão da 314b).
CREATE OR REPLACE FUNCTION wacrm.find_contacts_by_phone_suffix(p_account uuid, p_suffix text)
RETURNS SETOF wacrm.contacts
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT c.*
    FROM wacrm.contacts c
   WHERE c.account_id = p_account
     AND right(c.phone_normalized, 8) = p_suffix
   LIMIT 50
$$;

REVOKE ALL ON FUNCTION wacrm.find_contacts_by_phone_suffix(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.find_contacts_by_phone_suffix(uuid, text) TO authenticated, service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('314_contacts_phone_suffix_lookup') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
