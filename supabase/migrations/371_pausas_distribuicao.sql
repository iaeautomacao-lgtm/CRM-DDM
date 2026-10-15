-- ============================================================
-- 371_pausas_distribuicao.sql   (decisão do dono 15/10 — pausas: distribuição, fechamento por desconexão e alerta de estouro)
--
-- Continua a 370. A regra "pausado não recebe conversa nova" é do NÚCLEO da distribuição, vale para todas as contas e não se liga nem se
-- desliga (sem chave, sem fluxo): toda atribuição AUTOMÁTICA (fila/retry, round-robin de equipe, handoff do motor de fluxos, menu do cliente,
-- transbordo, handoff da IA) passa por um único critério de disponibilidade. No código é src/lib/pausas/availability.ts; no banco, abaixo.
--
-- O QUE FAZ:
--   1. wacrm.is_agent_available(user)   = ONLINE (member_presence 'online' visto há ≤ 75 s, a mesma régua do app) E SEM pausa aberta.
--   2. wacrm.agents_in_pause(users[])   quais dos usuários têm pausa aberta (service_role; usada pelo código para filtrar candidatos em lote).
--   3. wacrm.close_disconnected_pauses(minutos = 15)   fecha a pausa de quem sumiu: sem batimento há mais de N minutos (e a pausa com mais de
--      N minutos). end_kind = 'desconexao'; o fim fica no último sinal de vida (o relatório não conta o tempo offline). Auditoria pause.ended.
--   4. wacrm.claim_exceeded_pauses()    marca (uma vez por pausa) as abertas que passaram do tempo máximo do motivo e devolve quem estourou, para
--      o cron avisar o supervisor da equipe. Atômico: duas execuções simultâneas não avisam duas vezes. Não encerra nem retoma ninguém.
--   5. TRAVA DE ATRIBUIÇÃO MANUAL (trg_guard_paused_assignment, BEFORE UPDATE OF assigned_agent_id em conversations): um USUÁRIO logado (auth.uid()
--      não nulo, ou seja, UPDATE direto do navegador) não consegue atribuir conversa a quem está em pausa — erro 'agent_paused' pedindo a confirmação.
--      A confirmação vive na API (POST /api/conversations/{id}/transfer com confirm_paused:true, que escreve com service_role e registra na auditoria);
--      service_role (rotas, motor, cron) não passa pela trava: a distribuição automática já filtra pausados no código. Atribuir a SI MESMO é livre.
--   6. agent_pauses entra na publicação do Realtime (Monitoramento e topo do Inbox atualizam sem recarregar; a RLS da 370 vale).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.agent_pauses'), to_regclass('wacrm.member_presence'), to_regclass('wacrm.conversations');  -- não nulos (370, 024, 001)
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_guard_paused_assignment' AND NOT tgisinternal;                    -- 0 linhas na 1ª vez
--   SELECT to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)');                       -- existe
--   SELECT to_regprocedure('wacrm.is_agent_available(uuid)');                                                           -- NULL na 1ª vez
-- VERIFICAÇÃO (depois): SELECT wacrm.is_agent_available('<user>'::uuid);  -- false se offline ou pausado
-- ORDEM: depois da 370. Antes ou depois do deploy (sem ela o app não filtra pausados: o filtro do código tolera a ausência e o cron
--   /api/pausas/cron responde 503). Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_guard_paused_assignment ON wacrm.conversations;
--   DROP FUNCTION IF EXISTS wacrm.guard_paused_assignment();
--   DO $r$ BEGIN IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'wacrm' AND tablename = 'agent_pauses')
--     THEN ALTER PUBLICATION supabase_realtime DROP TABLE wacrm.agent_pauses; END IF; END $r$;
--   DROP FUNCTION IF EXISTS wacrm.claim_exceeded_pauses();
--   DROP FUNCTION IF EXISTS wacrm.close_disconnected_pauses(integer);
--   DROP FUNCTION IF EXISTS wacrm.agents_in_pause(uuid[]);
--   DROP FUNCTION IF EXISTS wacrm.is_agent_available(uuid);
--   DELETE FROM wacrm.schema_migrations WHERE version = '371_pausas_distribuicao';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.agent_pauses') IS NULL OR to_regclass('wacrm.member_presence') IS NULL OR to_regclass('wacrm.conversations') IS NULL THEN
    RAISE EXCEPTION '371: faltam wacrm.agent_pauses (migration 370) / member_presence (024) / conversations';
  END IF;
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '371: falta wacrm.audit_write (migration 131)';
  END IF;
END $$;

-- 1. Disponível = online (≤ 75 s, mesma régua de OFFLINE_AFTER_MS em src/lib/presence.ts) e sem pausa aberta.
CREATE OR REPLACE FUNCTION wacrm.is_agent_available(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
           SELECT 1 FROM wacrm.member_presence mp
            WHERE mp.user_id = p_user AND mp.status = 'online' AND mp.last_seen_at >= now() - interval '75 seconds')
     AND NOT EXISTS (SELECT 1 FROM wacrm.agent_pauses ap WHERE ap.user_id = p_user AND ap.ended_at IS NULL)
$$;

-- 2. Quem, dentre os usuários dados, está em pausa agora.
CREATE OR REPLACE FUNCTION wacrm.agents_in_pause(p_users uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ap.user_id FROM wacrm.agent_pauses ap WHERE ap.ended_at IS NULL AND ap.user_id = ANY (coalesce(p_users, '{}'::uuid[]))
$$;

-- 3. Fechamento por desconexão.
CREATE OR REPLACE FUNCTION wacrm.close_disconnected_pauses(p_minutes integer DEFAULT 15)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row record;
  v_n integer := 0;
  v_min integer := greatest(1, coalesce(p_minutes, 15));
BEGIN
  FOR v_row IN
    SELECT ap.id, ap.account_id, ap.user_id, ap.reason_name, ap.started_at,
           greatest(ap.started_at, coalesce(mp.last_seen_at, ap.started_at)) AS last_alive
      FROM wacrm.agent_pauses ap
      LEFT JOIN wacrm.member_presence mp ON mp.user_id = ap.user_id
     WHERE ap.ended_at IS NULL
       AND greatest(ap.started_at, coalesce(mp.last_seen_at, ap.started_at)) < now() - make_interval(mins => v_min)
     ORDER BY ap.started_at
       FOR UPDATE OF ap SKIP LOCKED
  LOOP
    UPDATE wacrm.agent_pauses SET ended_at = v_row.last_alive, end_kind = 'desconexao', ended_by = NULL
     WHERE id = v_row.id AND ended_at IS NULL;
    IF FOUND THEN
      v_n := v_n + 1;
      BEGIN
        PERFORM wacrm.audit_write(v_row.account_id, 'action', 'agent_pause', v_row.id,
          coalesce((SELECT nullif(p.full_name, '') FROM wacrm.profiles p WHERE p.user_id = v_row.user_id LIMIT 1), 'Atendente'),
          'pause.ended', format('Pausa encerrada por desconexão (%s)', v_row.reason_name), NULL,
          jsonb_build_object('user_id', v_row.user_id, 'end_kind', 'desconexao', 'reason', v_row.reason_name,
                             'seconds', round(extract(epoch FROM (v_row.last_alive - v_row.started_at)))));
      EXCEPTION WHEN others THEN
        RAISE WARNING 'close_disconnected_pauses: auditoria falhou: %', SQLERRM;   -- auditoria nunca impede o fechamento
      END;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- 4. Estouro do tempo: marca (uma vez) e devolve quem estourou.
CREATE OR REPLACE FUNCTION wacrm.claim_exceeded_pauses()
RETURNS TABLE (pause_id uuid, account_id uuid, user_id uuid, reason_name text, max_minutes integer, started_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE wacrm.agent_pauses ap
     SET alerted_at = now()
   WHERE ap.ended_at IS NULL AND ap.alerted_at IS NULL AND ap.max_minutes IS NOT NULL
     AND ap.started_at + make_interval(mins => ap.max_minutes) < now()
  RETURNING ap.id, ap.account_id, ap.user_id, ap.reason_name, ap.max_minutes, ap.started_at
$$;

REVOKE ALL ON FUNCTION wacrm.is_agent_available(uuid), wacrm.agents_in_pause(uuid[]), wacrm.close_disconnected_pauses(integer),
  wacrm.claim_exceeded_pauses() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.is_agent_available(uuid), wacrm.agents_in_pause(uuid[]), wacrm.close_disconnected_pauses(integer),
  wacrm.claim_exceeded_pauses() TO service_role;

-- 5. Trava da atribuição manual direta (UPDATE do navegador) a quem está em pausa.
CREATE OR REPLACE FUNCTION wacrm.guard_paused_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL                                  -- só o navegador (usuário logado); service_role/cron/motor passam
     AND NEW.assigned_agent_id IS NOT NULL
     AND NEW.assigned_agent_id IS DISTINCT FROM auth.uid()   -- assumir para si mesmo é livre
     AND EXISTS (SELECT 1 FROM wacrm.agent_pauses ap WHERE ap.user_id = NEW.assigned_agent_id AND ap.ended_at IS NULL) THEN
    RAISE EXCEPTION 'agent_paused: o atendente está em pausa; confirme a atribuição pela API de transferência (confirm_paused)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.guard_paused_assignment() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_paused_assignment ON wacrm.conversations;
CREATE TRIGGER trg_guard_paused_assignment BEFORE UPDATE OF assigned_agent_id ON wacrm.conversations
  FOR EACH ROW WHEN (NEW.assigned_agent_id IS NOT NULL AND OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id)
  EXECUTE FUNCTION wacrm.guard_paused_assignment();

-- 6. Realtime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'wacrm' AND tablename = 'agent_pauses') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wacrm.agent_pauses;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('371_pausas_distribuicao') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
