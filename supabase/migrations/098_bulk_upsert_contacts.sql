-- Migration 098: upsert em lote de contatos no import de CSV.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.
--
-- Substitui o dedup em memória de contacts/import/route.ts (que
-- carregava TODA a base de contatos da conta a cada import — inviável
-- acima de ~100K contatos) por um upsert de verdade no banco.
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
--   (RPC).
--
-- Por que a prioridade CPF-antes-de-telefone não cabe num único
-- ON CONFLICT:
--   Não existe UNIQUE em cpf (só um índice normal, não-único —
--   idx_contacts_cpf, migration 077), então não há dois índices únicos
--   pra alternar num só INSERT. A regra de negócio (mesmo aluno pode
--   reaparecer com telefone novo, mas o mesmo CPF deve casar com o
--   contato já existente) é replicada aqui como um passo explícito:
--   tenta achar por CPF primeiro (UPDATE direto, indexado); só se não
--   achar nada é que tenta o INSERT ... ON CONFLICT por telefone.
--
-- Regras de negócio preservadas EXATAMENTE como em contacts/import/route.ts:
--   - name: só sobrescreve se o nome atual for vazio/nulo OU "parecer
--     telefone" (igual ao próprio phone_normalized, ou bater no regex
--     ^\d{10,13}$) — nunca sobrescreve um nome real já cadastrado.
--   - cpf: nunca sobrescreve um CPF já gravado — só preenche quando
--     o campo está NULL (COALESCE(contacts.cpf, EXCLUDED.cpf), não o
--     inverso).
--   - email/company: nunca tocados num contato já existente — ausentes
--     do DO UPDATE SET de propósito, então ficam com o valor atual.
--   - telefone (phone/phone_normalized) de um contato já existente
--     NUNCA é atualizado, nem quando o match veio por CPF com um
--     telefone diferente no CSV — mesmo comportamento do código
--     original (só backfilla name/cpf, nunca troca o telefone
--     principal de um contato já cadastrado).
--   - updated_at: não setado explicitamente — o trigger
--     set_updated_at (migration 001) já cobre isso em qualquer UPDATE.
--
-- Ordem de retorno: jsonb_array_elements() preserva a ordem do array de
-- entrada, e RETURN NEXT dentro do loop acumula na mesma ordem — a
-- linha N do resultado corresponde sempre à linha N de p_rows. O
-- caller (route.ts) usa essa correspondência posicional pra religar
-- contact_phones/contact_import_variables/tags ao contato certo, não
-- o valor de phone_normalized (que, no caso de match por CPF com
-- telefone novo, reflete o telefone ANTIGO já gravado, não o do CSV).
--
-- Isolamento por linha: uma exceção numa linha (ex: violação de CHECK
-- constraint inesperada) não derruba o lote inteiro — captura, faz
-- ROLLBACK só daquela linha via savepoint implícito do bloco
-- EXCEPTION, e devolve contact_id NULL pra essa posição, que o caller
-- interpreta como erro daquela linha especificamente (mesmo espírito
-- do fallback linha-a-linha que existia em route.ts).
CREATE OR REPLACE FUNCTION wacrm.bulk_upsert_contacts(
  p_account_id uuid,
  p_user_id uuid,
  p_rows jsonb
)
RETURNS TABLE(contact_id uuid, phone_normalized text, is_new boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row jsonb;
  v_phone text;
  v_name text;
  v_email text;
  v_company text;
  v_cpf text;
  v_matched_by_cpf boolean;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_phone := v_row->>'phone';
    v_name := v_row->>'name';
    v_email := v_row->>'email';
    v_company := v_row->>'company';
    v_cpf := v_row->>'cpf';
    v_matched_by_cpf := false;
    contact_id := NULL;
    phone_normalized := NULL;
    is_new := false;

    BEGIN
      IF v_cpf IS NOT NULL THEN
        UPDATE wacrm.contacts AS c
        SET
          name = CASE
                   WHEN v_name IS NULL THEN c.name
                   WHEN c.name IS NULL OR c.name = '' OR c.name = c.phone_normalized
                        OR c.name ~ '^\d{10,13}$'
                   THEN v_name
                   ELSE c.name
                 END
        WHERE c.account_id = p_account_id AND c.cpf = v_cpf
        RETURNING c.id, c.phone_normalized INTO contact_id, phone_normalized;

        IF FOUND THEN
          v_matched_by_cpf := true;
          is_new := false;
        END IF;
      END IF;

      IF NOT v_matched_by_cpf THEN
        INSERT INTO wacrm.contacts AS c (user_id, account_id, phone, name, email, company, cpf)
        VALUES (p_user_id, p_account_id, v_phone, v_name, v_email, v_company, v_cpf)
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
        RETURNING c.id, c.phone_normalized, (xmax = 0) INTO contact_id, phone_normalized, is_new;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'bulk_upsert_contacts: falha na linha (phone=%, cpf=%): %', v_phone, v_cpf, SQLERRM;
      contact_id := NULL;
      phone_normalized := NULL;
      is_new := false;
    END;

    RETURN NEXT;
  END LOOP;
END;
$$;
