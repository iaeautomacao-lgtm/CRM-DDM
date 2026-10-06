-- ============================================================
-- 160_message_templates_waba_key_campaign_start_failure.sql
--
-- 1) Chave única do catálogo de templates passa a incluir a WABA:
--    (account_id, waba_id, name, language).
--    A chave antiga, UNIQUE (user_id, name, language) (014, índice
--    message_templates_user_name_language_key), ignorava a WABA: o mesmo
--    template (nome + idioma) em dois números/WABAs virava UMA linha e o
--    último sync/submit sobrescrevia o waba_id do outro. O sync agora
--    percorre todas as WABAs da conta (templates/sync/route.ts) e grava uma
--    linha por WABA.
-- 2) campaigns.motivo_falha_inicio (text): quando o início de uma campanha
--    falha (ex.: agendada com template inválido), ela volta para rascunho e
--    o card mostra o motivo. Antes o agendamento sumia sem aviso.
--
-- ANTES DE APLICAR — rodar no Supabase SQL Editor e conferir:
--
--   -- a) Índices/constraints únicos atuais da tabela (nome real em produção)
--   SELECT i.indexrelid::regclass AS indice,
--          c.conname              AS constraint_name,
--          pg_get_indexdef(i.indexrelid) AS definicao
--   FROM pg_index i
--   LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid
--   WHERE i.indrelid = 'wacrm.message_templates'::regclass
--     AND i.indisunique AND NOT i.indisprimary;
--
--   -- b) Duplicatas na chave nova (precisa voltar VAZIO; senão a migration
--   --    aborta com a lista — apague/una as linhas e rode de novo)
--   SELECT account_id, waba_id, name, language, count(*) AS linhas,
--          array_agg(id ORDER BY updated_at DESC NULLS LAST) AS ids
--   FROM wacrm.message_templates
--   WHERE waba_id IS NOT NULL
--   GROUP BY account_id, waba_id, name, language
--   HAVING count(*) > 1;
--
--   -- c) A coluna nova ainda não existe? (vazio = vai ser criada)
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'wacrm' AND table_name = 'campaigns'
--     AND column_name = 'motivo_falha_inicio';
--
-- Se (a) mostrar um índice único que JÁ inclui waba_id, a parte 1 não muda
-- nada além de criar o índice com o nome padrão abaixo (IF NOT EXISTS).
-- A migration remove só índices únicos cujas colunas sejam exatamente
-- (user_id, name, language) ou (account_id, name, language).
--
-- ORDEM: aplicar ANTES do deploy deste PR (a lista de campanhas lê
-- motivo_falha_inicio no polling). O código novo de submit/sync funciona
-- com a chave antiga e com a nova; o código ANTIGO de submit
-- (upsert onConflict user_id,name,language) falha depois desta migration —
-- por isso aplicar imediatamente antes do deploy.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

SET search_path TO wacrm, public, extensions;

-- Duplicatas na chave nova: aborta com a lista em vez de falhar no CREATE
-- UNIQUE INDEX com uma mensagem genérica.
DO $$
DECLARE
  dupe_count INT;
  sample TEXT;
BEGIN
  SELECT count(*), string_agg(detail, E'\n  ')
  INTO dupe_count, sample
  FROM (
    SELECT account_id::text || ' / ' || waba_id || ' / ' || name || ' / ' ||
           COALESCE(language, '(null)') || ' (' || count(*) || ' linhas)' AS detail
    FROM wacrm.message_templates
    WHERE waba_id IS NOT NULL
    GROUP BY account_id, waba_id, name, language
    HAVING count(*) > 1
  ) d;

  IF dupe_count > 0 THEN
    RAISE EXCEPTION
      E'message_templates tem % combinação(ões) duplicada(s) de (account_id, waba_id, name, language):\n  %\nApague as linhas que não quer manter e rode de novo.',
      dupe_count, sample;
  END IF;
END $$;

-- Remove a chave antiga, qualquer que seja o nome em produção (índice ou
-- constraint).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT i.indexrelid::regclass::text AS index_name,
           c.conname AS constraint_name
    FROM pg_index i
    LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid AND c.conrelid = i.indrelid
    WHERE i.indrelid = 'wacrm.message_templates'::regclass
      AND i.indisunique
      AND NOT i.indisprimary
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(i.indkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      ) IN (
        ARRAY['language', 'name', 'user_id'],
        ARRAY['account_id', 'language', 'name']
      )
  LOOP
    IF r.constraint_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE wacrm.message_templates DROP CONSTRAINT %I', r.constraint_name);
    ELSE
      EXECUTE format('DROP INDEX %s', r.index_name);
    END IF;
  END LOOP;
END $$;

-- Nova chave. waba_id nulo (linhas sincronizadas antes da 073) não entra
-- em conflito entre si; o próximo sync adota essas linhas para a WABA.
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_waba_name_language_key
  ON wacrm.message_templates (account_id, waba_id, name, language);

-- Motivo da última falha ao iniciar a campanha (limpo ao editar ou ao
-- iniciar com sucesso).
ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS motivo_falha_inicio TEXT;

COMMIT;

NOTIFY pgrst, 'reload schema';
