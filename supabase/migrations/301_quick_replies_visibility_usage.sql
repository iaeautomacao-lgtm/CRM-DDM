-- ============================================================
-- 301_quick_replies_visibility_usage.sql   (TASK1 item 4 — Respostas rápidas: visibilidade e usos em 30 dias)
--
-- 1) VISIBILIDADE em wacrm.quick_replies: coluna `visibility` ('personal' | 'team' | 'account'; as que já existem ficam 'account') e
--    `team_id` (obrigatório se 'team', proibido nas demais). 'personal' pertence a created_by.
--      - ler:  account → todos da conta; team → membros da equipe (e admin/proprietário); personal → só o dono.
--      - criar/editar/excluir: account e team → admin ou proprietário (como já era); personal → o próprio dono (agent ou acima),
--        e o dono NÃO consegue promover para team/account (WITH CHECK força 'personal').
--    O atalho deixa de ser único na conta: passa a ser único por escopo (conta, equipe ou dono), então duas pessoas podem ter /oi pessoais.
--    A ordem de resolução de atalhos repetidos no composer fica com o front (sugestão: pessoal > equipe > conta).
-- 2) USOS: wacrm.quick_reply_usage_daily (contador por resposta/usuário/dia, escrito só pelo servidor via bump_quick_reply_use) e
--    wacrm.quick_reply_usage_30d() (SECURITY INVOKER → só das respostas que a RLS deixa o usuário ver) → (quick_reply_id, uses).
--    Linhas com mais de 35 dias da mesma resposta são podadas a cada registro (a tabela não cresce sem limite).
--
-- PRÉ-CHECK:  SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='quick_replies' AND column_name='visibility';  -- 0 linhas
--             SELECT conname FROM pg_constraint WHERE conrelid='wacrm.quick_replies'::regclass AND contype='u';  -- confira o nome do UNIQUE (account_id, shortcut)
-- ROLLBACK:   (ATENÇÃO: apaga as respostas personal/team — sem a coluna visibility elas virariam da conta toda e vazariam; reverta o código ANTES)
--             DROP FUNCTION IF EXISTS wacrm.quick_reply_usage_30d(), wacrm.bump_quick_reply_use(uuid, uuid, uuid);
--             DROP TABLE IF EXISTS wacrm.quick_reply_usage_daily;
--             DELETE FROM wacrm.quick_replies WHERE visibility IN ('personal', 'team');
--             DROP POLICY IF EXISTS quick_replies_select ON wacrm.quick_replies;
--             DROP POLICY IF EXISTS quick_replies_insert ON wacrm.quick_replies;
--             DROP POLICY IF EXISTS quick_replies_update ON wacrm.quick_replies;
--             DROP POLICY IF EXISTS quick_replies_delete ON wacrm.quick_replies;
--             CREATE POLICY quick_replies_select ON wacrm.quick_replies FOR SELECT USING (wacrm.is_account_member(account_id));
--             CREATE POLICY quick_replies_insert ON wacrm.quick_replies FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY quick_replies_update ON wacrm.quick_replies FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY quick_replies_delete ON wacrm.quick_replies FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
--             DROP INDEX IF EXISTS wacrm.idx_quick_replies_scope_shortcut;
--             ALTER TABLE wacrm.quick_replies DROP COLUMN IF EXISTS visibility, DROP COLUMN IF EXISTS team_id;
--             ALTER TABLE wacrm.quick_replies ADD CONSTRAINT quick_replies_account_id_shortcut_key UNIQUE (account_id, shortcut);
--             DELETE FROM wacrm.schema_migrations WHERE version = '301_quick_replies_visibility_usage';
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.quick_replies') IS NULL OR to_regclass('wacrm.teams') IS NULL OR to_regclass('wacrm.team_members') IS NULL THEN
    RAISE EXCEPTION '301: faltam wacrm.quick_replies/teams/team_members';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '301: wacrm.is_account_member não existe';
  END IF;
END $$;

-- ---------- 1) visibilidade ----------
ALTER TABLE wacrm.quick_replies ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'account';
ALTER TABLE wacrm.quick_replies ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES wacrm.teams(id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quick_replies_visibility_chk' AND conrelid = 'wacrm.quick_replies'::regclass) THEN
    ALTER TABLE wacrm.quick_replies ADD CONSTRAINT quick_replies_visibility_chk CHECK (visibility IN ('personal', 'team', 'account'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quick_replies_team_scope_chk' AND conrelid = 'wacrm.quick_replies'::regclass) THEN
    ALTER TABLE wacrm.quick_replies ADD CONSTRAINT quick_replies_team_scope_chk CHECK ((visibility = 'team') = (team_id IS NOT NULL));
  END IF;
END $$;

ALTER TABLE wacrm.quick_replies DROP CONSTRAINT IF EXISTS quick_replies_account_id_shortcut_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_scope_shortcut ON wacrm.quick_replies (
  account_id, shortcut, visibility,
  COALESCE(CASE visibility WHEN 'team' THEN team_id WHEN 'personal' THEN created_by END, '00000000-0000-0000-0000-000000000000'::uuid));

DROP POLICY IF EXISTS quick_replies_select ON wacrm.quick_replies;
CREATE POLICY quick_replies_select ON wacrm.quick_replies
  FOR SELECT USING (
    wacrm.is_account_member(account_id) AND (
      visibility = 'account'
      OR (visibility = 'personal' AND created_by = auth.uid())
      OR (visibility = 'team' AND (
            wacrm.is_account_member(account_id, 'admin')
            OR team_id IN (SELECT tm.team_id FROM wacrm.team_members tm WHERE tm.user_id = auth.uid())))
    ));

DROP POLICY IF EXISTS quick_replies_insert ON wacrm.quick_replies;
CREATE POLICY quick_replies_insert ON wacrm.quick_replies
  FOR INSERT WITH CHECK (
    (visibility IN ('account', 'team') AND wacrm.is_account_member(account_id, 'admin')
       AND (team_id IS NULL OR EXISTS (SELECT 1 FROM wacrm.teams t WHERE t.id = quick_replies.team_id AND t.account_id = quick_replies.account_id)))
    OR (visibility = 'personal' AND created_by = auth.uid() AND wacrm.is_account_member(account_id, 'agent'))
  );

DROP POLICY IF EXISTS quick_replies_update ON wacrm.quick_replies;
CREATE POLICY quick_replies_update ON wacrm.quick_replies
  FOR UPDATE
  USING (
    (visibility IN ('account', 'team') AND wacrm.is_account_member(account_id, 'admin'))
    OR (visibility = 'personal' AND created_by = auth.uid())
  )
  WITH CHECK (
    (visibility IN ('account', 'team') AND wacrm.is_account_member(account_id, 'admin')
       AND (team_id IS NULL OR EXISTS (SELECT 1 FROM wacrm.teams t WHERE t.id = quick_replies.team_id AND t.account_id = quick_replies.account_id)))
    OR (visibility = 'personal' AND created_by = auth.uid() AND wacrm.is_account_member(account_id, 'agent'))
  );

DROP POLICY IF EXISTS quick_replies_delete ON wacrm.quick_replies;
CREATE POLICY quick_replies_delete ON wacrm.quick_replies
  FOR DELETE USING (
    (visibility IN ('account', 'team') AND wacrm.is_account_member(account_id, 'admin'))
    OR (visibility = 'personal' AND created_by = auth.uid())
  );

-- ---------- 2) usos ----------
CREATE TABLE IF NOT EXISTS wacrm.quick_reply_usage_daily (
  quick_reply_id uuid NOT NULL REFERENCES wacrm.quick_replies(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  day            date NOT NULL,
  account_id     uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  uses           integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  PRIMARY KEY (quick_reply_id, user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_quick_reply_usage_account_day ON wacrm.quick_reply_usage_daily (account_id, day);

ALTER TABLE wacrm.quick_reply_usage_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quick_reply_usage_select ON wacrm.quick_reply_usage_daily;
CREATE POLICY quick_reply_usage_select ON wacrm.quick_reply_usage_daily
  FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.quick_replies q WHERE q.id = quick_reply_usage_daily.quick_reply_id));  -- RLS da resposta vale
GRANT SELECT ON wacrm.quick_reply_usage_daily TO authenticated;
GRANT ALL ON wacrm.quick_reply_usage_daily TO service_role;

CREATE OR REPLACE FUNCTION wacrm.bump_quick_reply_use(p_reply uuid, p_account uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wacrm.quick_replies q WHERE q.id = p_reply AND q.account_id = p_account) THEN
    RETURN;
  END IF;
  INSERT INTO wacrm.quick_reply_usage_daily (quick_reply_id, user_id, day, account_id, uses)
  VALUES (p_reply, p_user, current_date, p_account, 1)
  ON CONFLICT (quick_reply_id, user_id, day) DO UPDATE SET uses = wacrm.quick_reply_usage_daily.uses + 1;
  DELETE FROM wacrm.quick_reply_usage_daily WHERE quick_reply_id = p_reply AND day < current_date - 35;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.bump_quick_reply_use(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.bump_quick_reply_use(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION wacrm.quick_reply_usage_30d()
RETURNS TABLE (quick_reply_id uuid, uses bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT q.id, COALESCE(sum(u.uses), 0)::bigint
    FROM wacrm.quick_replies q
    LEFT JOIN wacrm.quick_reply_usage_daily u ON u.quick_reply_id = q.id AND u.day > current_date - 30
   WHERE q.account_id = wacrm.current_account_id()
   GROUP BY q.id;
$$;
GRANT EXECUTE ON FUNCTION wacrm.quick_reply_usage_30d() TO authenticated;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('301_quick_replies_visibility_usage') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
