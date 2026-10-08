-- ============================================================
-- 157_tabulacao_ia_sugestao.sql — tabulação com IA: sugestão + procedência
-- e mapa tag de saída da IA → tabulação.
--
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy: o código
-- novo grava estas colunas no fechamento (/api/conversations/[id]/close),
-- na reabertura (webhooks Meta/WAHA/Webchat/sociais), na automação
-- close_conversation e nas sugestões da IA — sem elas o PostgREST rejeita
-- o UPDATE e o fechamento/reabertura falha.
-- Conferir o schema live antes (CLAUDE.md): wacrm.conversations,
-- wacrm.tags (kind/codigo_tabulacao, 041) e is_account_member (017/140).
--
-- 1. conversations — sugestão (não é a tabulação; o humano confirma):
--      suggested_outcome_tag_id      tag sugerida (FK tags, SET NULL)
--      outcome_suggestion_source     'exit_tag' (tag de saída da IA no
--                                    fluxo) | 'llm' (classificador) | 'rule'
--      outcome_suggestion_confidence 0..1
--      outcome_suggestion_reason     texto curto
--      outcome_suggested_at
--      outcome_suggestion_key        id da última mensagem analisada —
--                                    cache: reabrir o picker sem mensagem
--                                    nova não chama a IA de novo
--    procedência da tabulação efetiva (outcome_tag_id):
--      outcome_source  'human' | 'ai_auto' | 'automation'
--      outcome_set_by  usuário (quando humano)
--      outcome_set_at
--    O suggested_* é mantido depois do fechamento humano: comparar com
--    outcome_tag_id dá a taxa de aceite da sugestão.
--
-- 2. wacrm.ai_exit_tag_outcome_map — por conta, qual tabulação cada tag de
--    saída da IA (#ACORDOFORMALIZADO, #RECUSA_CONFIRMADA…) sugere.
--    auto_close (default false): fechar a conversa sozinho com essa
--    tabulação — DECISÃO DE PRODUTO PENDENTE, por isso nasce desligado.
--    RLS: membros leem, admin+ escreve.
--    Seed: contas existentes, casando o codigo_tabulacao semeado (041); a
--    linha só entra se a conta tem a tag. Contas novas: trigger em tags
--    cria o mapeamento quando a tag de desfecho com o código é inserida
--    (seed_tabulacao_tags).
--
-- Idempotente.
-- ============================================================

BEGIN;

SET search_path TO wacrm, public, extensions;

-- ------------------------------------------------------------
-- 1. conversations
-- ------------------------------------------------------------
ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS suggested_outcome_tag_id uuid
    REFERENCES wacrm.tags(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outcome_suggestion_source text,
  ADD COLUMN IF NOT EXISTS outcome_suggestion_confidence numeric,
  ADD COLUMN IF NOT EXISTS outcome_suggestion_reason text,
  ADD COLUMN IF NOT EXISTS outcome_suggested_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_suggestion_key text,
  ADD COLUMN IF NOT EXISTS outcome_source text,
  ADD COLUMN IF NOT EXISTS outcome_set_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outcome_set_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_outcome_suggestion_source_check'
      AND conrelid = 'wacrm.conversations'::regclass
  ) THEN
    ALTER TABLE wacrm.conversations
      ADD CONSTRAINT conversations_outcome_suggestion_source_check
      CHECK (outcome_suggestion_source IS NULL
             OR outcome_suggestion_source IN ('exit_tag', 'llm', 'rule'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_outcome_suggestion_confidence_check'
      AND conrelid = 'wacrm.conversations'::regclass
  ) THEN
    ALTER TABLE wacrm.conversations
      ADD CONSTRAINT conversations_outcome_suggestion_confidence_check
      CHECK (outcome_suggestion_confidence IS NULL
             OR (outcome_suggestion_confidence >= 0 AND outcome_suggestion_confidence <= 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_outcome_source_check'
      AND conrelid = 'wacrm.conversations'::regclass
  ) THEN
    ALTER TABLE wacrm.conversations
      ADD CONSTRAINT conversations_outcome_source_check
      CHECK (outcome_source IS NULL
             OR outcome_source IN ('human', 'ai_auto', 'automation'));
  END IF;
END
$$;

-- FK com ON DELETE SET NULL: apagar uma tag não pode varrer conversations.
CREATE INDEX IF NOT EXISTS conversations_suggested_outcome_tag_idx
  ON wacrm.conversations (suggested_outcome_tag_id)
  WHERE suggested_outcome_tag_id IS NOT NULL;

COMMENT ON COLUMN wacrm.conversations.suggested_outcome_tag_id IS
  'Tabulação sugerida (IA/fluxo). Não é a tabulação efetiva — ver outcome_tag_id.';
COMMENT ON COLUMN wacrm.conversations.outcome_suggestion_key IS
  'Id da última mensagem analisada pela sugestão (cache do suggest-tag).';
COMMENT ON COLUMN wacrm.conversations.outcome_source IS
  'Quem definiu outcome_tag_id: human | ai_auto | automation.';

-- ------------------------------------------------------------
-- 2. ai_exit_tag_outcome_map
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.ai_exit_tag_outcome_map (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  exit_tag       text NOT NULL,
  outcome_tag_id uuid NOT NULL REFERENCES wacrm.tags(id) ON DELETE CASCADE,
  auto_close     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_exit_tag_outcome_map_account_tag_key UNIQUE (account_id, exit_tag),
  CONSTRAINT ai_exit_tag_outcome_map_exit_tag_format
    CHECK (exit_tag ~ '^#[A-Z][A-Z0-9_]*$')
);

CREATE INDEX IF NOT EXISTS ai_exit_tag_outcome_map_outcome_tag_idx
  ON wacrm.ai_exit_tag_outcome_map (outcome_tag_id);

ALTER TABLE wacrm.ai_exit_tag_outcome_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_exit_tag_outcome_map_select ON wacrm.ai_exit_tag_outcome_map;
CREATE POLICY ai_exit_tag_outcome_map_select ON wacrm.ai_exit_tag_outcome_map
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_exit_tag_outcome_map_insert ON wacrm.ai_exit_tag_outcome_map;
CREATE POLICY ai_exit_tag_outcome_map_insert ON wacrm.ai_exit_tag_outcome_map
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_exit_tag_outcome_map_update ON wacrm.ai_exit_tag_outcome_map;
CREATE POLICY ai_exit_tag_outcome_map_update ON wacrm.ai_exit_tag_outcome_map
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_exit_tag_outcome_map_delete ON wacrm.ai_exit_tag_outcome_map;
CREATE POLICY ai_exit_tag_outcome_map_delete ON wacrm.ai_exit_tag_outcome_map
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- Mapeamento padrão tag de saída → codigo_tabulacao (041).
CREATE OR REPLACE FUNCTION wacrm.default_ai_exit_tag_for_codigo(p_codigo integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_codigo
    WHEN 142 THEN '#ACORDOFORMALIZADO'
    WHEN 220 THEN '#RECUSA_CONFIRMADA'
    WHEN 178 THEN '#CONTESTACAO_DIVIDA'
    WHEN 156 THEN '#OPT_OUT'
    WHEN 227 THEN '#CPF_NAO_LOCALIZADO'
    WHEN 376 THEN '#AGENDAMENTO'
    WHEN 208 THEN '#CONTATO_DIVERGENTE'
    ELSE NULL
  END;
$$;

-- Seed das contas existentes (só quando a conta tem a tag com o código;
-- havendo duplicata do código, vale a mais antiga).
INSERT INTO wacrm.ai_exit_tag_outcome_map (account_id, exit_tag, outcome_tag_id)
SELECT DISTINCT ON (t.account_id, wacrm.default_ai_exit_tag_for_codigo(t.codigo_tabulacao))
       t.account_id,
       wacrm.default_ai_exit_tag_for_codigo(t.codigo_tabulacao),
       t.id
FROM wacrm.tags t
WHERE t.kind = 'outcome'
  AND t.account_id IS NOT NULL
  AND wacrm.default_ai_exit_tag_for_codigo(t.codigo_tabulacao) IS NOT NULL
ORDER BY t.account_id, wacrm.default_ai_exit_tag_for_codigo(t.codigo_tabulacao), t.created_at, t.id
ON CONFLICT (account_id, exit_tag) DO NOTHING;

-- Contas novas: quando seed_tabulacao_tags (ou um admin) cria a tag de
-- desfecho com um dos códigos acima, o mapeamento padrão nasce junto
-- (auto_close = false). Não sobrescreve mapeamento existente.
CREATE OR REPLACE FUNCTION wacrm.tg_seed_ai_exit_tag_outcome_map()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_exit_tag text;
BEGIN
  IF NEW.kind IS DISTINCT FROM 'outcome' OR NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_exit_tag := wacrm.default_ai_exit_tag_for_codigo(NEW.codigo_tabulacao);
  IF v_exit_tag IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO wacrm.ai_exit_tag_outcome_map (account_id, exit_tag, outcome_tag_id)
  VALUES (NEW.account_id, v_exit_tag, NEW.id)
  ON CONFLICT (account_id, exit_tag) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS seed_ai_exit_tag_outcome_map ON wacrm.tags;
CREATE TRIGGER seed_ai_exit_tag_outcome_map
  AFTER INSERT ON wacrm.tags
  FOR EACH ROW
  EXECUTE FUNCTION wacrm.tg_seed_ai_exit_tag_outcome_map();

COMMIT;

NOTIFY pgrst, 'reload schema';
