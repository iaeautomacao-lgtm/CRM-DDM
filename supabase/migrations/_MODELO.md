# Modelo de migration (regras do projeto)

Migrations são aplicadas **à mão** no SQL Editor do Supabase. Este arquivo não é uma migration (não termina em `.sql`).

## Regras

1. **Número livre e único.** Próximo número da faixa do PRD; o CI falha se dois arquivos tiverem o mesmo número
   (`node scripts/ci/check-migration-numbers.mjs`). Depois de criar o arquivo: `node scripts/schema-check.mjs --generate`.
2. **Confira o schema vivo antes** (os arquivos podem não refletir produção).
3. **PRÉ-CHECK vivo** no começo (aborta SEM alterar nada se o schema não for o esperado), **idempotente**, em `BEGIN … COMMIT`.
4. **Cabeçalho**: o que faz · pré-check (consultas) · verificação pós-aplicação · ordem em relação ao deploy · **rollback**.
5. **Registro (obrigatório)**: a migration termina se registrando, dentro da transação, antes do `COMMIT`:

   ```sql
   DO $$ BEGIN
     IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
       INSERT INTO wacrm.schema_migrations (version) VALUES ('NNN_nome_do_arquivo') ON CONFLICT DO NOTHING;
     END IF;
   END $$;
   ```

   (O `IF` deixa a migration rodar mesmo em banco sem a 202.) `version` = nome do arquivo sem `.sql`.
6. **`CREATE INDEX CONCURRENTLY`**: arquivo próprio `NNNb_…`, **1ª linha**
   `-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (sem outro comando junto).`
   Não pode estar em transação, então **não se registra**: o `schema:check` a detecta pelo índice (inclusive `indisvalid = false`).
7. Nunca altere migration já aplicada para "corrigir produção": crie outra.

## Esqueleto

```sql
-- ============================================================
-- NNN_nome.sql   (PRD x.y — resumo)
-- O que faz: …
-- PRÉ-CHECK: …
-- VERIFICAÇÃO: …
-- ORDEM: antes/depois do deploy …
-- ROLLBACK: …
-- ============================================================
BEGIN;

DO $$ BEGIN
  IF to_regclass('wacrm.tabela_esperada') IS NULL THEN
    RAISE EXCEPTION 'NNN: falta wacrm.tabela_esperada';
  END IF;
END $$;

-- … mudanças idempotentes …

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('NNN_nome') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
```
