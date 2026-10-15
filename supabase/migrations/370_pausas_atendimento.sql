-- ============================================================
-- 370_pausas_atendimento.sql   (decisão do dono 15/10 — pausas de atendimento; desenho: prd-v2/pausas-desenho.md)
--
-- A pausa é do SISTEMA (existe sempre, em todas as contas; sem chave, sem feature flag, sem nó de fluxo). Configurável é só: os motivos, o
-- tempo máximo de cada um e QUEM pode pausar quem (permissões). "Pausado não recebe conversa nova" é regra do núcleo da distribuição (371).
--
-- O QUE FAZ:
--   1. Permissões novas no catálogo (espelho de src/lib/auth/permissions.ts) e nos papéis de SISTEMA:
--        presence.pause_self      owner, admin, supervisor, agent   pausar/retomar a si mesmo
--        presence.pause_others    owner, admin, supervisor          pausar/retomar outros (supervisor só das equipes dele; quem tem
--                                                                    monitoring.view_all, a conta toda)
--        presence.reasons_manage  owner, admin                      criar/editar/desativar motivos
--   2. wacrm.pause_reasons  motivos por conta (nome até 40, tempo máximo opcional, ativo, ordem). Nunca se apaga motivo (só desativa).
--   3. wacrm.agent_pauses   uma linha por pausa; no máximo UMA ABERTA por atendente (índice único parcial). `reason_name`/`max_minutes` são
--      cópias (o histórico sobrevive a renomear/editar o motivo). Leitura por RLS: o próprio; monitoring.view_team/reports.view_team =
--      equipes dele; monitoring.view_all/reports.view_all = a conta. Escrita SÓ pelas RPCs abaixo (e service_role).
--   4. wacrm.start_pause(motivo, alvo?) e wacrm.end_pause(alvo?): SECURITY DEFINER com auth.uid(); a conta e a permissão saem do chamador
--      (nunca do cliente). Devolvem jsonb { ok, code?, pause? } com os códigos que a API repassa: forbidden, other_team, user_not_found,
--      reason_not_found, reason_inactive, already_paused, not_paused, paused_by_supervisor. Auditoria pause.started / pause.ended.
--   5. wacrm.ensure_default_pause_reasons(conta): cria Almoço 60, Banheiro 10, Treinamento 120, Outro sem limite se a conta não tem
--      nenhum motivo (idempotente; a API chama na primeira leitura).
--   "Conta como tempo de trabalho" fica para a 2ª fase (decisão do dono): NÃO há coluna para isso.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.accounts'), to_regclass('wacrm.profiles'), to_regclass('wacrm.team_members'), to_regclass('wacrm.member_presence'),
--          to_regclass('wacrm.permission_catalog'), to_regclass('wacrm.role_permissions'), to_regclass('wacrm.account_roles');   -- não nulos
--   SELECT to_regprocedure('wacrm.has_perm(text)'), to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)'),
--          (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member');   -- ≥ 1 (017; assinatura com 2 argumentos, por isso a busca por nome)
--   SELECT key FROM wacrm.permission_catalog WHERE key LIKE 'presence.%';                                                           -- 0 linhas na 1ª vez
--   SELECT to_regclass('wacrm.pause_reasons'), to_regclass('wacrm.agent_pauses');                                                    -- NULL, NULL na 1ª vez
-- VERIFICAÇÃO (depois):
--   SELECT key FROM wacrm.permission_catalog WHERE key LIKE 'presence.%' ORDER BY 1;                                                 -- 3 linhas
--   SELECT indexname FROM pg_indexes WHERE schemaname = 'wacrm' AND tablename = 'agent_pauses' AND indexname = 'uq_agent_pauses_open';  -- 1 linha
-- ORDEM: depois da 366 (e da 311, 241, 131); ANTES da 371. Antes ou depois do deploy (sem ela as rotas /api/pausas respondem 503 e a
--   distribuição segue como hoje). Idempotente.
-- ROLLBACK (executável; a 371 precisa ser revertida antes):
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.start_pause(uuid, uuid);
--   DROP FUNCTION IF EXISTS wacrm.end_pause(uuid);
--   DROP FUNCTION IF EXISTS wacrm.ensure_default_pause_reasons(uuid);
--   DROP FUNCTION IF EXISTS wacrm.pause_other_denied(uuid);
--   DROP FUNCTION IF EXISTS wacrm.pause_json(wacrm.agent_pauses);
--   DROP TABLE IF EXISTS wacrm.agent_pauses;   -- antes de pause_shares_team (as policies dela chamam a função)
--   DROP FUNCTION IF EXISTS wacrm.pause_shares_team(uuid);
--   DROP TABLE IF EXISTS wacrm.pause_reasons;
--   DELETE FROM wacrm.role_permissions WHERE permission LIKE 'presence.%';
--   DELETE FROM wacrm.permission_catalog WHERE key LIKE 'presence.%';
--   DELETE FROM wacrm.schema_migrations WHERE version = '370_pausas_atendimento';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.profiles') IS NULL OR to_regclass('wacrm.team_members') IS NULL
     OR to_regclass('wacrm.member_presence') IS NULL THEN
    RAISE EXCEPTION '370: faltam wacrm.accounts / profiles / team_members / member_presence — confira o schema vivo';
  END IF;
  IF to_regclass('wacrm.permission_catalog') IS NULL OR to_regclass('wacrm.role_permissions') IS NULL OR to_regclass('wacrm.account_roles') IS NULL THEN
    RAISE EXCEPTION '370: faltam as tabelas de papéis (migration 240)';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '370: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '370: falta wacrm.audit_write (migration 131)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '370: falta wacrm.is_account_member(uuid) (migration 017)';
  END IF;
END $$;

-- ---------- 1. Permissões (catálogo + papéis de sistema) ----------
INSERT INTO wacrm.permission_catalog (key, label, description, group_name, scope, owner_only, grantable, depends_on, sort) VALUES
  ('presence.pause_self', 'Pausar a si mesmo', 'Entrar em pausa (almoço, banheiro…) e voltar ao atendimento.', 'Pausas', 'own', false, true,
   ARRAY['inbox.view']::text[], 690),
  ('presence.pause_others', 'Pausar outros atendentes', 'Pausar e retomar outros atendentes (supervisor: só das equipes dele; quem vê a organização toda: qualquer um).', 'Pausas', 'team', false, true,
   ARRAY['presence.pause_self', 'monitoring.view_team']::text[], 700),
  ('presence.reasons_manage', 'Gerenciar motivos de pausa', 'Criar, editar e desativar os motivos de pausa e o tempo máximo de cada um.', 'Pausas', 'n/a', false, true,
   ARRAY[]::text[], 710)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, group_name = EXCLUDED.group_name,
  scope = EXCLUDED.scope, owner_only = EXCLUDED.owner_only, grantable = EXCLUDED.grantable, depends_on = EXCLUDED.depends_on, sort = EXCLUDED.sort;

INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, p.perm
  FROM wacrm.account_roles r
  JOIN (VALUES
    ('owner', 'presence.pause_self'), ('admin', 'presence.pause_self'), ('supervisor', 'presence.pause_self'), ('agent', 'presence.pause_self'),
    ('owner', 'presence.pause_others'), ('admin', 'presence.pause_others'), ('supervisor', 'presence.pause_others'),
    ('owner', 'presence.reasons_manage'), ('admin', 'presence.reasons_manage')
  ) AS p(role_key, perm) ON p.role_key = r.key
 WHERE r.account_id IS NULL
ON CONFLICT (role_id, permission) DO NOTHING;

-- ---------- 2. Motivos ----------
CREATE TABLE IF NOT EXISTS wacrm.pause_reasons (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  max_minutes integer     CHECK (max_minutes IS NULL OR max_minutes BETWEEN 1 AND 1440),   -- NULL = sem limite
  active      boolean     NOT NULL DEFAULT true,
  sort_order  integer     NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pause_reasons_account_name ON wacrm.pause_reasons (account_id, lower(btrim(name)));

ALTER TABLE wacrm.pause_reasons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pause_reasons_select ON wacrm.pause_reasons;
CREATE POLICY pause_reasons_select ON wacrm.pause_reasons FOR SELECT USING (
  wacrm.is_account_member(account_id)
  AND ((SELECT wacrm.has_perm('presence.pause_self')) OR (SELECT wacrm.has_perm('presence.reasons_manage')))
);
DROP POLICY IF EXISTS pause_reasons_insert ON wacrm.pause_reasons;
CREATE POLICY pause_reasons_insert ON wacrm.pause_reasons FOR INSERT WITH CHECK (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('presence.reasons_manage'))
);
DROP POLICY IF EXISTS pause_reasons_update ON wacrm.pause_reasons;
CREATE POLICY pause_reasons_update ON wacrm.pause_reasons FOR UPDATE USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('presence.reasons_manage'))
) WITH CHECK (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('presence.reasons_manage'))
);
-- Sem policy de DELETE: motivo nunca é apagado (só desativado), o histórico depende dele.
REVOKE ALL ON wacrm.pause_reasons FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON wacrm.pause_reasons TO authenticated;
GRANT ALL ON wacrm.pause_reasons TO service_role;

-- ---------- 3. Pausas ----------
CREATE TABLE IF NOT EXISTS wacrm.agent_pauses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason_id   uuid        REFERENCES wacrm.pause_reasons(id) ON DELETE SET NULL,
  reason_name text        NOT NULL,                       -- cópia: o histórico sobrevive a renomear o motivo
  max_minutes integer,                                    -- cópia do limite no momento da pausa (NULL = sem limite)
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,                                -- NULL = em andamento
  started_by  uuid,
  ended_by    uuid,
  end_kind    text        CHECK (end_kind IN ('manual', 'supervisor', 'desconexao')),
  alerted_at  timestamptz,                                -- quando o estouro do tempo foi avisado (uma vez por pausa)
  CONSTRAINT agent_pauses_period CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT agent_pauses_end_kind CHECK ((ended_at IS NULL) = (end_kind IS NULL))
);
-- UMA pausa aberta por atendente (a RPC trata a violação como `already_paused`).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_pauses_open ON wacrm.agent_pauses (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_pauses_account_started ON wacrm.agent_pauses (account_id, started_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_agent_pauses_user_started ON wacrm.agent_pauses (user_id, started_at DESC);

-- O alvo divide ao menos uma equipe com o usuário logado?
CREATE OR REPLACE FUNCTION wacrm.pause_shares_team(p_target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM wacrm.team_members me
      JOIN wacrm.team_members other ON other.team_id = me.team_id
     WHERE me.user_id = auth.uid() AND other.user_id = p_target
  )
$$;
REVOKE ALL ON FUNCTION wacrm.pause_shares_team(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.pause_shares_team(uuid) TO authenticated, service_role;

ALTER TABLE wacrm.agent_pauses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_pauses_select ON wacrm.agent_pauses;
CREATE POLICY agent_pauses_select ON wacrm.agent_pauses FOR SELECT USING (
  wacrm.is_account_member(account_id)
  AND (
    user_id = (SELECT auth.uid())
    OR (SELECT wacrm.has_perm('monitoring.view_all'))
    OR (SELECT wacrm.has_perm('reports.view_all'))
    OR (((SELECT wacrm.has_perm('monitoring.view_team')) OR (SELECT wacrm.has_perm('reports.view_team'))) AND wacrm.pause_shares_team(user_id))
  )
);
-- Escrita só pelas RPCs (SECURITY DEFINER) e pelo service_role (cron): nenhuma policy de INSERT/UPDATE/DELETE para usuários.
REVOKE ALL ON wacrm.agent_pauses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.agent_pauses TO authenticated;
GRANT ALL ON wacrm.agent_pauses TO service_role;

-- 2FA (migration 310): se já aplicada, cobre as tabelas aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy') THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.pause_reasons'::regclass);
    PERFORM wacrm.apply_mfa_policy('wacrm.agent_pauses'::regclass);
  END IF;
END $$;

-- ---------- 5. Motivos padrão ----------
CREATE OR REPLACE FUNCTION wacrm.ensure_default_pause_reasons(p_account uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer := 0;
BEGIN
  IF p_account IS NULL OR EXISTS (SELECT 1 FROM wacrm.pause_reasons WHERE account_id = p_account) THEN RETURN 0; END IF;
  INSERT INTO wacrm.pause_reasons (account_id, name, max_minutes, sort_order) VALUES
    (p_account, 'Almoço', 60, 10), (p_account, 'Banheiro', 10, 20), (p_account, 'Treinamento', 120, 30), (p_account, 'Outro', NULL, 40)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.ensure_default_pause_reasons(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.ensure_default_pause_reasons(uuid) TO service_role;

-- ---------- 4. RPCs ----------
-- Quem chama pode agir sobre `p_target`? (já sabendo que o alvo é de OUTRA pessoa e da mesma conta). null = pode.
CREATE OR REPLACE FUNCTION wacrm.pause_other_denied(p_target uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT wacrm.has_perm('presence.pause_others') THEN RETURN 'forbidden'; END IF;
  IF wacrm.has_perm('monitoring.view_all') THEN RETURN NULL; END IF;
  IF wacrm.has_perm('monitoring.view_team') AND wacrm.pause_shares_team(p_target) THEN RETURN NULL; END IF;
  RETURN 'other_team';
END;
$$;
REVOKE ALL ON FUNCTION wacrm.pause_other_denied(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.pause_other_denied(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION wacrm.pause_json(p wacrm.agent_pauses)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object('id', p.id, 'user_id', p.user_id, 'reason_id', p.reason_id, 'reason_name', p.reason_name,
    'max_minutes', p.max_minutes, 'started_at', p.started_at, 'ended_at', p.ended_at, 'end_kind', p.end_kind,
    'started_by', p.started_by, 'ended_by', p.ended_by, 'alerted_at', p.alerted_at)
$$;
REVOKE ALL ON FUNCTION wacrm.pause_json(wacrm.agent_pauses) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.pause_json(wacrm.agent_pauses) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION wacrm.start_pause(p_reason_id uuid, p_target_user uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_account uuid;
  v_target uuid;
  v_target_account uuid;
  v_denied text;
  v_reason wacrm.pause_reasons%ROWTYPE;
  v_pause wacrm.agent_pauses%ROWTYPE;
  v_label text;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'unauthenticated'); END IF;
  SELECT p.account_id INTO v_account FROM wacrm.profiles p WHERE p.user_id = v_me AND p.deactivated_at IS NULL LIMIT 1;
  IF v_account IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'forbidden'); END IF;
  v_target := coalesce(p_target_user, v_me);

  IF v_target = v_me THEN
    IF NOT wacrm.has_perm('presence.pause_self') THEN RETURN jsonb_build_object('ok', false, 'code', 'forbidden'); END IF;
  ELSE
    -- Outro usuário: precisa ser da MESMA conta e ativo (404 igual para inexistente e de outra conta: não revela quem existe).
    SELECT p.account_id, p.full_name INTO v_target_account, v_label FROM wacrm.profiles p WHERE p.user_id = v_target AND p.deactivated_at IS NULL LIMIT 1;
    IF NOT FOUND OR v_target_account IS DISTINCT FROM v_account THEN RETURN jsonb_build_object('ok', false, 'code', 'user_not_found'); END IF;
    v_denied := wacrm.pause_other_denied(v_target);
    IF v_denied IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_denied); END IF;
  END IF;

  SELECT * INTO v_reason FROM wacrm.pause_reasons r WHERE r.id = p_reason_id AND r.account_id = v_account;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'reason_not_found'); END IF;
  IF NOT v_reason.active THEN RETURN jsonb_build_object('ok', false, 'code', 'reason_inactive'); END IF;

  BEGIN
    INSERT INTO wacrm.agent_pauses (account_id, user_id, reason_id, reason_name, max_minutes, started_by)
    VALUES (v_account, v_target, v_reason.id, v_reason.name, v_reason.max_minutes, v_me)
    RETURNING * INTO v_pause;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_pause FROM wacrm.agent_pauses p WHERE p.user_id = v_target AND p.ended_at IS NULL LIMIT 1;
    RETURN jsonb_build_object('ok', false, 'code', 'already_paused', 'pause', wacrm.pause_json(v_pause));
  END;

  SELECT coalesce(nullif(p.full_name, ''), 'Atendente') INTO v_label FROM wacrm.profiles p WHERE p.user_id = v_target LIMIT 1;
  PERFORM wacrm.audit_write(v_account, 'action', 'agent_pause', v_pause.id, v_label, 'pause.started',
    format('%s entrou em pausa (%s)', v_label, v_reason.name), NULL,
    jsonb_build_object('user_id', v_target, 'started_by', v_me, 'by_supervisor', v_target <> v_me, 'reason', v_reason.name, 'max_minutes', v_reason.max_minutes));
  RETURN jsonb_build_object('ok', true, 'pause', wacrm.pause_json(v_pause));
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.end_pause(p_target_user uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_account uuid;
  v_target uuid;
  v_target_account uuid;
  v_denied text;
  v_pause wacrm.agent_pauses%ROWTYPE;
  v_label text;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'unauthenticated'); END IF;
  SELECT p.account_id INTO v_account FROM wacrm.profiles p WHERE p.user_id = v_me AND p.deactivated_at IS NULL LIMIT 1;
  IF v_account IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'forbidden'); END IF;
  v_target := coalesce(p_target_user, v_me);

  IF v_target = v_me THEN
    IF NOT wacrm.has_perm('presence.pause_self') THEN RETURN jsonb_build_object('ok', false, 'code', 'forbidden'); END IF;
  ELSE
    SELECT p.account_id INTO v_target_account FROM wacrm.profiles p WHERE p.user_id = v_target LIMIT 1;
    IF NOT FOUND OR v_target_account IS DISTINCT FROM v_account THEN RETURN jsonb_build_object('ok', false, 'code', 'user_not_found'); END IF;
    v_denied := wacrm.pause_other_denied(v_target);
    IF v_denied IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_denied); END IF;
  END IF;

  SELECT * INTO v_pause FROM wacrm.agent_pauses p WHERE p.user_id = v_target AND p.account_id = v_account AND p.ended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_paused'); END IF;

  -- Quem foi pausado por outra pessoa só é retomado por quem tem escopo sobre ele (o próprio atendente não se despausa).
  IF v_target = v_me AND v_pause.started_by IS NOT NULL AND v_pause.started_by <> v_me THEN
    RETURN jsonb_build_object('ok', false, 'code', 'paused_by_supervisor', 'pause', wacrm.pause_json(v_pause));
  END IF;

  UPDATE wacrm.agent_pauses
     SET ended_at = now(), ended_by = v_me, end_kind = CASE WHEN v_target = v_me THEN 'manual' ELSE 'supervisor' END
   WHERE id = v_pause.id
  RETURNING * INTO v_pause;

  SELECT coalesce(nullif(p.full_name, ''), 'Atendente') INTO v_label FROM wacrm.profiles p WHERE p.user_id = v_target LIMIT 1;
  PERFORM wacrm.audit_write(v_account, 'action', 'agent_pause', v_pause.id, v_label, 'pause.ended',
    format('%s voltou ao atendimento (%s)', v_label, v_pause.reason_name), NULL,
    jsonb_build_object('user_id', v_target, 'ended_by', v_me, 'end_kind', v_pause.end_kind, 'reason', v_pause.reason_name,
                       'seconds', round(extract(epoch FROM (v_pause.ended_at - v_pause.started_at)))));
  RETURN jsonb_build_object('ok', true, 'pause', wacrm.pause_json(v_pause));
END;
$$;
REVOKE ALL ON FUNCTION wacrm.start_pause(uuid, uuid), wacrm.end_pause(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.start_pause(uuid, uuid), wacrm.end_pause(uuid) TO authenticated, service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('370_pausas_atendimento') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
