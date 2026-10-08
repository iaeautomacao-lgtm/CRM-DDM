-- 181: preenchimento em lote de nome/CPF na importação de contatos (B10 — capacidade 100k).
--
-- Antes: a reimportação de uma base já existente fazia UM UPDATE por contato (100 mil idas ao banco,
-- ~2 h com 10 em paralelo). Agora o servidor manda um bloco (até 1.000 contatos) numa chamada só:
-- um único UPDATE … FROM jsonb_to_recordset.
--
-- Regras idênticas às do código anterior: o nome é gravado quando vem preenchido (o servidor já decidiu
-- que o contato precisa dele); o CPF só entra se o contato ainda NÃO tem CPF. Só toca contatos da conta.
-- Se esta função não existir, o app cai no caminho antigo (linha a linha) — pode ser aplicada depois do deploy.
--
-- Idempotente (CREATE OR REPLACE). Só service_role executa. Aplicar no SQL Editor.

CREATE OR REPLACE FUNCTION wacrm.import_backfill_contacts(p_account_id uuid, p_items jsonb)
RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
  WITH upd AS (
    UPDATE wacrm.contacts c
       SET name = COALESCE(NULLIF(i.name, ''), c.name),
           cpf  = CASE WHEN c.cpf IS NULL THEN NULLIF(i.cpf, '') ELSE c.cpf END
      FROM jsonb_to_recordset(p_items) AS i(id uuid, name text, cpf text)
     WHERE c.id = i.id
       AND c.account_id = p_account_id
    RETURNING 1
  )
  SELECT count(*)::integer FROM upd;
$$;

REVOKE ALL ON FUNCTION wacrm.import_backfill_contacts(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.import_backfill_contacts(uuid, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
