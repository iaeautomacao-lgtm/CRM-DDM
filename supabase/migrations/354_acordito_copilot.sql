-- ============================================================
-- 354_acordito_copilot.sql   (decisão do dono 14/10 — Acordito, o copiloto interno do atendente)
--
-- O Acordito sugere 3 respostas para o atendente a partir do histórico da conversa; NUNCA envia nada sozinho. Esta migration
-- cria o que o backend precisa (a API é /api/ai/copilot/* e /api/account/copilot-config):
--   wacrm.copilot_config       (account_id PK) enabled (padrão false), guidance (texto de orientação vindo da operação, pela tela;
--                              vazio = o código usa um padrão neutro mínimo). RLS: ler = quem usa o inbox (inbox.view); gravar = ai.config.
--   wacrm.copilot_suggestions  cache: as sugestões geradas para (conversa, última mensagem do cliente). Só service_role (sem policy).
--   wacrm.copilot_events       evento por sugestão (used | edited | ignored) para métrica. RLS: ler = reports.view_all;
--                              inserir = o próprio usuário, com inbox.reply (a API grava pelo service_role).
--   Cota diária: o tipo 'copilot' entra em wacrm.ai_daily_quota_config/usage e em wacrm.consume_ai_quota (a 339 só conhecia
--   'stt' e 'tag_suggest'); o padrão (DEFAULT_AI_DAILY_LIMITS) mora no código, e o teto de uma conta muda por linha.
-- COMPATIBILIDADE: sem esta migration a API responde 409 copilot_disabled (a tela mostra o Acordito desligado); nada mais muda.
-- ORDEM: depois da 339 (cota de IA) e da 240 (has_perm); antes ou depois do deploy. Idempotente.
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.copilot_config'), to_regclass('wacrm.copilot_events');                         -- NULL, NULL na 1ª vez
--             SELECT to_regprocedure('wacrm.has_perm(text)'), to_regprocedure('wacrm.consume_ai_quota(uuid,text,integer)');   -- as duas existem
-- VERIFICAÇÃO: INSERT em copilot_config como atendente (sem ai.config) → negado; SELECT em copilot_suggestions como authenticated → negado.
-- ROLLBACK:   BEGIN;
--             DROP TABLE IF EXISTS wacrm.copilot_events;
--             DROP TABLE IF EXISTS wacrm.copilot_suggestions;
--             DROP TABLE IF EXISTS wacrm.copilot_config;
--             DELETE FROM wacrm.ai_daily_quota_usage WHERE kind = 'copilot';
--             DELETE FROM wacrm.ai_daily_quota_config WHERE kind = 'copilot';
--             ALTER TABLE wacrm.ai_daily_quota_config DROP CONSTRAINT IF EXISTS ai_daily_quota_config_kind_check;
--             ALTER TABLE wacrm.ai_daily_quota_config ADD CONSTRAINT ai_daily_quota_config_kind_check CHECK (kind IN ('stt', 'tag_suggest'));
--             ALTER TABLE wacrm.ai_daily_quota_usage DROP CONSTRAINT IF EXISTS ai_daily_quota_usage_kind_check;
--             ALTER TABLE wacrm.ai_daily_quota_usage ADD CONSTRAINT ai_daily_quota_usage_kind_check CHECK (kind IN ('stt', 'tag_suggest'));
--             CREATE OR REPLACE FUNCTION wacrm.consume_ai_quota(p_account uuid, p_kind text, p_default_limit integer)
--             RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
--             DECLARE
--               v_day   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
--               v_limit integer;
--               v_used  integer;
--             BEGIN
--               IF p_account IS NULL OR p_kind NOT IN ('stt', 'tag_suggest') THEN
--                 RETURN jsonb_build_object('allowed', false, 'used', 0, 'limit', 0);
--               END IF;
--               SELECT c.daily_limit INTO v_limit FROM wacrm.ai_daily_quota_config c WHERE c.account_id = p_account AND c.kind = p_kind;
--               v_limit := COALESCE(v_limit, GREATEST(COALESCE(p_default_limit, 0), 0));
--               DELETE FROM wacrm.ai_daily_quota_usage WHERE day < v_day - 10;
--               INSERT INTO wacrm.ai_daily_quota_usage AS u (account_id, kind, day, used)
--               SELECT p_account, p_kind, v_day, 1 WHERE v_limit >= 1
--               ON CONFLICT (account_id, kind, day) DO UPDATE SET used = u.used + 1 WHERE u.used < v_limit
--               RETURNING u.used INTO v_used;
--               IF v_used IS NULL THEN
--                 SELECT u.used INTO v_used FROM wacrm.ai_daily_quota_usage u WHERE u.account_id = p_account AND u.kind = p_kind AND u.day = v_day;
--                 RETURN jsonb_build_object('allowed', false, 'used', COALESCE(v_used, 0), 'limit', v_limit);
--               END IF;
--               RETURN jsonb_build_object('allowed', true, 'used', v_used, 'limit', v_limit);
--             END;
--             $fn$;
--             DELETE FROM wacrm.schema_migrations WHERE version = '354_acordito_copilot';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '354: falta wacrm.has_perm(text) (migration 240) — nada foi alterado';
  END IF;
  IF to_regprocedure('wacrm.consume_ai_quota(uuid,text,integer)') IS NULL THEN
    RAISE EXCEPTION '354: falta wacrm.consume_ai_quota (rode antes a 339_ai_daily_quota) — nada foi alterado';
  END IF;
  IF to_regclass('wacrm.conversations') IS NULL THEN
    RAISE EXCEPTION '354: falta wacrm.conversations — confira o schema vivo';
  END IF;
END $$;

-- ---------- Configuração por conta ----------
CREATE TABLE IF NOT EXISTS wacrm.copilot_config (
  account_id uuid        PRIMARY KEY REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  enabled    boolean     NOT NULL DEFAULT false,
  guidance   text        NOT NULL DEFAULT '' CHECK (char_length(guidance) <= 4000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE wacrm.copilot_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS copilot_config_select ON wacrm.copilot_config;
CREATE POLICY copilot_config_select ON wacrm.copilot_config FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('inbox.view'))
);
DROP POLICY IF EXISTS copilot_config_insert ON wacrm.copilot_config;
CREATE POLICY copilot_config_insert ON wacrm.copilot_config FOR INSERT WITH CHECK (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('ai.config'))
);
DROP POLICY IF EXISTS copilot_config_update ON wacrm.copilot_config;
CREATE POLICY copilot_config_update ON wacrm.copilot_config FOR UPDATE USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('ai.config'))
) WITH CHECK (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('ai.config'))
);
REVOKE ALL ON wacrm.copilot_config FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON wacrm.copilot_config TO authenticated;
GRANT ALL ON wacrm.copilot_config TO service_role;

-- ---------- Cache de sugestões (só o servidor) ----------
CREATE TABLE IF NOT EXISTS wacrm.copilot_suggestions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  conversation_id     uuid        NOT NULL REFERENCES wacrm.conversations(id) ON DELETE CASCADE,
  based_on_message_id uuid        NOT NULL,
  suggestions         jsonb       NOT NULL,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_copilot_suggestions_lookup
  ON wacrm.copilot_suggestions (conversation_id, based_on_message_id, created_at DESC);

ALTER TABLE wacrm.copilot_suggestions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.copilot_suggestions FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.copilot_suggestions TO service_role;

-- ---------- Eventos para métrica ----------
CREATE TABLE IF NOT EXISTS wacrm.copilot_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  conversation_id uuid        NOT NULL REFERENCES wacrm.conversations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  suggestion_id   text        NOT NULL CHECK (char_length(suggestion_id) BETWEEN 1 AND 64),
  action          text        NOT NULL CHECK (action IN ('used', 'edited', 'ignored')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_copilot_events_account ON wacrm.copilot_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_events_conversation ON wacrm.copilot_events (conversation_id);

ALTER TABLE wacrm.copilot_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS copilot_events_select ON wacrm.copilot_events;
CREATE POLICY copilot_events_select ON wacrm.copilot_events FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('reports.view_all'))
);
DROP POLICY IF EXISTS copilot_events_insert ON wacrm.copilot_events;
CREATE POLICY copilot_events_insert ON wacrm.copilot_events FOR INSERT WITH CHECK (
  wacrm.is_account_member(account_id) AND user_id = (SELECT auth.uid()) AND (SELECT wacrm.has_perm('inbox.reply'))
);
REVOKE ALL ON wacrm.copilot_events FROM PUBLIC, anon;
GRANT SELECT, INSERT ON wacrm.copilot_events TO authenticated;
GRANT ALL ON wacrm.copilot_events TO service_role;

-- 2FA (migration 310): se já aplicada, cobre as tabelas aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy'
  ) THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.copilot_config'::regclass);
    PERFORM wacrm.apply_mfa_policy('wacrm.copilot_suggestions'::regclass);
    PERFORM wacrm.apply_mfa_policy('wacrm.copilot_events'::regclass);
  END IF;
END $$;

-- ---------- Cota diária: o tipo 'copilot' ----------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN ('wacrm.ai_daily_quota_config'::regclass, 'wacrm.ai_daily_quota_usage'::regclass)
      AND pg_get_constraintdef(c.oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
ALTER TABLE wacrm.ai_daily_quota_config ADD CONSTRAINT ai_daily_quota_config_kind_check CHECK (kind IN ('stt', 'tag_suggest', 'copilot'));
ALTER TABLE wacrm.ai_daily_quota_usage  ADD CONSTRAINT ai_daily_quota_usage_kind_check  CHECK (kind IN ('stt', 'tag_suggest', 'copilot'));

CREATE OR REPLACE FUNCTION wacrm.consume_ai_quota(p_account uuid, p_kind text, p_default_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_day   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_limit integer;
  v_used  integer;
BEGIN
  IF p_account IS NULL OR p_kind NOT IN ('stt', 'tag_suggest', 'copilot') THEN
    RETURN jsonb_build_object('allowed', false, 'used', 0, 'limit', 0);
  END IF;
  SELECT c.daily_limit INTO v_limit FROM wacrm.ai_daily_quota_config c WHERE c.account_id = p_account AND c.kind = p_kind;
  v_limit := COALESCE(v_limit, GREATEST(COALESCE(p_default_limit, 0), 0));

  -- Limpeza barata de contagens antigas.
  DELETE FROM wacrm.ai_daily_quota_usage WHERE day < v_day - 10;

  -- Só incrementa se ainda houver cota: a chamada negada não consome.
  INSERT INTO wacrm.ai_daily_quota_usage AS u (account_id, kind, day, used)
  SELECT p_account, p_kind, v_day, 1 WHERE v_limit >= 1
  ON CONFLICT (account_id, kind, day) DO UPDATE SET used = u.used + 1 WHERE u.used < v_limit
  RETURNING u.used INTO v_used;

  IF v_used IS NULL THEN
    SELECT u.used INTO v_used FROM wacrm.ai_daily_quota_usage u WHERE u.account_id = p_account AND u.kind = p_kind AND u.day = v_day;
    RETURN jsonb_build_object('allowed', false, 'used', COALESCE(v_used, 0), 'limit', v_limit);
  END IF;
  RETURN jsonb_build_object('allowed', true, 'used', v_used, 'limit', v_limit);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.consume_ai_quota(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.consume_ai_quota(uuid, text, integer) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('354_acordito_copilot') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
