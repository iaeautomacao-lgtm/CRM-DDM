-- Migration 098: upsert em lote de contatos no import de CSV.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.
--
-- Substitui o dedup em memória de contacts/import/route.ts (que
-- carregava TODA a base de contatos da conta a cada import — inviável
-- acima de ~100K contatos) por um upsert de verdade no banco.
--
-- HISTÓRICO desta function (por que ela já mudou de forma duas vezes):
--   v1 (jsonb + loop linha-a-linha): funcionava, mas devolvia
--     contact_id/phone_normalized/is_new sempre NULL em produção —
--     causa raiz aparente: os nomes de RETURNS TABLE colidiam
--     textualmente com colunas reais de wacrm.contacts referenciadas
--     dentro da function.
--   v2 (jsonb + loop, saída renomeada out_*): corrigiu o NULL, mas
--     processava 500 INSERT/UPDATE individuais por chunk de 500 —
--     mais lento que o INSERT em lote do código antigo (confirmado ao
--     vivo: 10.000 linhas passou de ~66s pro código antigo pra >120s
--     nesta versão, chegando a estourar o timeout do cliente).
--   v3 (esta) — arrays + UM INSERT em lote por chunk via unnest().
--
-- Por que isso precisa ser uma function em vez de .upsert() do
-- supabase-js:
--   O UNIQUE real em (account_id, phone_normalized)
--   (idx_contacts_account_phone_normalized, migration 022) é um ÍNDICE
--   PARCIAL — `WHERE phone_normalized <> ''`. Postgres só aceita um
--   ON CONFLICT como match de um índice parcial se a cláusula repetir
--   literalmente o mesmo WHERE; o método .upsert() do client só aceita
--   uma lista de colunas em onConflict, sem jeito de anexar um WHERE.
--   Não dá pra fazer esse upsert específico via REST — só via SQL bruto
--   (RPC). Confirmado ao vivo: um .upsert() sem o WHERE falha com
--   42P10 "no unique or exclusion constraint matching the ON CONFLICT
--   specification".
--
-- Por que a prioridade CPF-antes-de-telefone precisa de DOIS statements
-- separados (não um único INSERT):
--   Não existe UNIQUE em cpf (só um índice normal, não-único —
--   idx_contacts_cpf, migration 077), então não há dois índices únicos
--   pra alternar num só INSERT ON CONFLICT. A regra de negócio (mesmo
--   aluno pode reaparecer com telefone novo, mas o mesmo CPF deve casar
--   com o contato já existente) é replicada como dois passos em lote:
--
--   Passo 1 — UPDATE em lote por CPF (todas as linhas com cpf não-nulo
--   de uma vez, via FROM unnest(...) WITH ORDINALITY), capturando
--   ordinality + id + phone_normalized de cada linha resolvida em
--   arrays PL/pgSQL (v_cpf_*).
--
--   Passo 2 — INSERT ... ON CONFLICT em lote (uma única instrução) só
--   para as linhas cuja ordinality NÃO apareceu no passo 1.
--
--   Os dois passos são STATEMENTS SEPARADOS (não CTEs graváveis dentro
--   da mesma query) de propósito: a documentação do Postgres deixa
--   "não especificado" o resultado quando mais de um WITH gravável no
--   MESMO statement pode afetar a mesma linha. Como statements
--   sequenciais dentro da function, o passo 2 sempre enxerga o efeito
--   já committed (dentro da transação) do passo 1 — semântica normal e
--   bem definida de execução sequencial, sem a ambiguidade de CTEs
--   graváveis concorrentes.
--
-- Regras de negócio preservadas EXATAMENTE como nas versões anteriores:
--   - name: só sobrescreve se o nome atual for vazio/nulo OU "parecer
--     telefone" (igual ao próprio phone_normalized, ou bater no regex
--     ^\d{10,13}$) — nunca sobrescreve um nome real já cadastrado.
--   - cpf: nunca sobrescreve um CPF já gravado — só preenche quando o
--     campo está NULL (COALESCE(contacts.cpf, EXCLUDED.cpf)).
--   - email/company: nunca tocados num contato já existente.
--   - telefone (phone/phone_normalized) de um contato já existente
--     NUNCA é atualizado, nem quando o match veio por CPF com um
--     telefone diferente no CSV.
--   - updated_at: não setado explicitamente — o trigger
--     set_updated_at (migration 001) já cobre isso em qualquer UPDATE.
--
-- Correspondência posicional: a saída final usa LEFT JOIN a partir do
-- unnest() original (todas as N posições de entrada), então a function
-- SEMPRE devolve exatamente N linhas para N telefones de entrada, na
-- ordem original — inclusive NULL pras posições que não bateram em
-- nenhum dos dois passos (ex: telefone nulo, não deveria acontecer já
-- que route.ts valida antes de chamar, mas a saída não pode desalinhar
-- a correspondência posicional que route.ts depende pra religar
-- contact_phones/contact_import_variables/tags).
--
-- Isolamento de erro: diferente das versões anteriores, NÃO há
-- EXCEPTION handler por linha aqui — um statement em lote não consegue
-- isolar uma linha ruim das outras 499 do mesmo chunk. Se alguma linha
-- violar uma constraint inesperada, o chunk inteiro falha e o erro
-- propaga normalmente pro chamador; route.ts já trata isso (o branch
-- `if (error)` já existente marca o chunk inteiro como erro por linha).
--
-- RETURNS TABLE muda de assinatura, então precisa de DROP FUNCTION
-- antes do CREATE — Postgres rejeita CREATE OR REPLACE que muda tipo
-- de retorno com "cannot change return type of existing function".
DROP FUNCTION IF EXISTS wacrm.bulk_upsert_contacts(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS wacrm.bulk_upsert_contacts(uuid, uuid, text[], text[], text[], text[], text[]);

CREATE OR REPLACE FUNCTION wacrm.bulk_upsert_contacts(
  p_account_id uuid,
  p_user_id uuid,
  p_phones text[],
  p_names text[],
  p_emails text[],
  p_companies text[],
  p_cpfs text[]
)
RETURNS TABLE(out_contact_id uuid, out_phone_normalized text, out_is_new boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_cpf_ordinalities bigint[];
  v_cpf_contact_ids uuid[];
  v_cpf_phone_normalized text[];
BEGIN
  -- Passo 1: match por CPF em lote (prioridade sobre telefone).
  WITH rows AS (
    SELECT *
    FROM unnest(p_phones, p_names, p_emails, p_companies, p_cpfs)
      WITH ORDINALITY AS t(phone, name, email, company, cpf, ordinality)
  ),
  upd AS (
    UPDATE wacrm.contacts AS c
    SET
      name = CASE
               WHEN r.name IS NULL THEN c.name
               WHEN c.name IS NULL OR c.name = '' OR c.name = c.phone_normalized
                    OR c.name ~ '^\d{10,13}$'
               THEN r.name
               ELSE c.name
             END
    FROM rows r
    WHERE c.account_id = p_account_id
      AND r.cpf IS NOT NULL
      AND c.cpf = r.cpf
    RETURNING r.ordinality, c.id, c.phone_normalized
  )
  SELECT
    COALESCE(array_agg(ordinality), ARRAY[]::bigint[]),
    COALESCE(array_agg(id), ARRAY[]::uuid[]),
    COALESCE(array_agg(phone_normalized), ARRAY[]::text[])
  INTO v_cpf_ordinalities, v_cpf_contact_ids, v_cpf_phone_normalized
  FROM upd;

  -- Passo 2 + saída final: INSERT em lote por telefone (só linhas não
  -- resolvidas no passo 1), combinado com os resultados do passo 1,
  -- devolvido na ordem original de entrada.
  RETURN QUERY
  WITH rows AS (
    SELECT *
    FROM unnest(p_phones, p_names, p_emails, p_companies, p_cpfs)
      WITH ORDINALITY AS t(phone, name, email, company, cpf, ordinality)
  ),
  to_insert AS (
    SELECT r.*
    FROM rows r
    WHERE r.phone IS NOT NULL
      AND NOT (r.ordinality = ANY (v_cpf_ordinalities))
  ),
  ins AS (
    INSERT INTO wacrm.contacts AS c (user_id, account_id, phone, name, email, company, cpf)
    SELECT p_user_id, p_account_id, ti.phone, ti.name, ti.email, ti.company, ti.cpf
    FROM to_insert ti
    ON CONFLICT (account_id, phone_normalized) WHERE (phone_normalized <> '')
    DO UPDATE SET
      name = CASE
               WHEN EXCLUDED.name IS NULL THEN c.name
               WHEN c.name IS NULL OR c.name = '' OR c.name = c.phone_normalized
                    OR c.name ~ '^\d{10,13}$'
               THEN EXCLUDED.name
               ELSE c.name
             END,
      cpf = COALESCE(c.cpf, EXCLUDED.cpf)
    RETURNING c.id AS contact_id, c.phone_normalized, (xmax = 0) AS is_new
  ),
  insert_matched AS (
    SELECT ti.ordinality, ins.contact_id, ins.phone_normalized, ins.is_new
    FROM ins
    JOIN to_insert ti
      ON regexp_replace(ti.phone, '\D', '', 'g') = ins.phone_normalized
  ),
  cpf_matched AS (
    SELECT t.ordinality, t.contact_id, t.phone_normalized, false AS is_new
    FROM unnest(v_cpf_ordinalities, v_cpf_contact_ids, v_cpf_phone_normalized)
      AS t(ordinality, contact_id, phone_normalized)
  ),
  combined AS (
    SELECT * FROM cpf_matched
    UNION ALL
    SELECT * FROM insert_matched
  )
  SELECT combined.contact_id, combined.phone_normalized, combined.is_new
  FROM rows r
  LEFT JOIN combined ON combined.ordinality = r.ordinality
  ORDER BY r.ordinality;
END;
$$;
