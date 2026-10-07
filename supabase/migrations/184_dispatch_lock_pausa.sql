-- ============================================================
-- 184_dispatch_lock_pausa.sql   (P0-6 da auditoria do disparador: F4 + F5)
--
-- F4 — LOCK DO CRON CURTO. O lock `disparador_cron` valia 600 s e a renovação (a cada 20 s) SEMPRE estendia para
--      600 s: deploy/crash no meio do tick deixava ~10 min sem nenhum envio (`already_running`). Agora:
--        * renew_cron_lock(p_name, p_owner, p_ttl_seconds DEFAULT 90): renova para 90 s (o heartbeat de 20 s cobre com folga;
--          `lostLease` continua protegendo contra tick lento);
--        * try_acquire_cron_lock: TTL padrão 90 s (o cron passa 90 explicitamente; os demais locks mantêm o TTL que passam).
--      Efeito: crash/deploy no meio do tick = no máximo ~1,5–2 min sem envio.
--
-- F5 — PAUSAR / ENCERRAR / RETOMAR CAMPANHA GRANDE. Antes: 1 UPDATE de até 100k itens na MESMA transação, com a campanha em
--      FOR UPDATE; se estourasse o statement_timeout, tudo desfazia e a campanha seguia `em_execucao` (o freio falhava
--      justamente na emergência) e os claims ficavam parados esperando o lock. Agora:
--        * stop_dispatch_campaign / resume_dispatch_campaign / resume_dispatch_campaign_keep_schedule trocam SÓ
--          campaigns.status (e gravam um "job de movimentação" em wacrm.dispatch_campaign_moves) — milissegundos;
--        * o claim já exige campanha `em_execucao` (167), então pausar/encerrar é INSTANTÂNEO: nenhum item é enviado depois
--          da pausa confirmada (o stop trava a campanha FOR UPDATE; todo claim posterior vê o status novo);
--        * wacrm.process_dispatch_campaign_moves(p_campaign_id, p_limit, p_max_jobs) move os itens em LOTES (padrão 5.000,
--          FOR UPDATE SKIP LOCKED, cada chamada = 1 transação curta): chamada pela rota (stop/resume) e pelo cron (manutenção).
--          pause: agendado/pendente → pausado · stop: agendado/pendente/pausado → cancelado · resume: pausado → agendado
--          (resume: scheduled_at = agora; resume_keep: preserva o scheduled_at já redistribuído pelo reflow — sem rajada).
--          Item agendado sob campanha pausada é inerte (o claim não o pega); item pausado sob campanha em execução NÃO é enviado
--          até ser movido — por isso o job só some quando não resta item a mover.
--
-- ┌─ PRÉ-CHECK (rode ANTES e CONFIRA — o corpo de produção pode divergir dos arquivos do repositório) ─────────────────┐
-- │ SELECT pg_get_functiondef('wacrm.try_acquire_cron_lock(text,text,integer)'::regprocedure);                        │
-- │ SELECT pg_get_functiondef('wacrm.renew_cron_lock(text,text)'::regprocedure);                                      │
-- │ SELECT pg_get_functiondef('wacrm.stop_dispatch_campaign(uuid,uuid,text)'::regprocedure);                          │
-- │ SELECT pg_get_functiondef('wacrm.resume_dispatch_campaign_keep_schedule(uuid,uuid)'::regprocedure);               │
-- │ SELECT pg_get_functiondef('wacrm.resume_dispatch_campaign(uuid,uuid)'::regprocedure);                             │
-- │ SHOW statement_timeout;   -- e, por papel: SELECT rolname, rolconfig FROM pg_roles WHERE rolconfig IS NOT NULL;   │
-- │ Conferir: renew usa `expires_at > clock_timestamp()` e `owner_id = p_owner`; stop devolve boolean e só aceita       │
-- │ 'pause' de campanha `em_execucao`; resume devolve integer (NULL se a campanha não está 'pausada'). Se divergir,     │
-- │ ajuste este arquivo antes de rodar. O bloco DO abaixo aborta se os retornos não forem os esperados.                │
-- └───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ORDEM: aplicar ANTES do deploy do código. (Código novo + migration antiga: tudo continua funcionando — o código só
-- passa TTL 90 na aquisição e chama a RPC nova de movimentação, que é ignorada se não existir.)
-- ROLLBACK: reaplicar 123 (renew) e 133 (stop/resume) restaura o comportamento anterior; jobs pendentes ficam inertes.
--
-- Idempotente (CREATE OR REPLACE / IF NOT EXISTS / DROP IF EXISTS). Só service_role executa.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v text;
BEGIN
  IF to_regclass('wacrm.cron_locks') IS NULL OR to_regclass('wacrm.campaigns') IS NULL OR to_regclass('wacrm.disp_message_queue') IS NULL THEN
    RAISE EXCEPTION '184: faltam wacrm.cron_locks / campaigns / disp_message_queue';
  END IF;
  IF to_regprocedure('wacrm.try_acquire_cron_lock(text,text,integer)') IS NULL THEN
    RAISE EXCEPTION '184: falta wacrm.try_acquire_cron_lock(text,text,integer) (migration 113)';
  END IF;
  IF to_regprocedure('wacrm.stop_dispatch_campaign(uuid,uuid,text)') IS NOT NULL THEN
    SELECT pg_get_function_result('wacrm.stop_dispatch_campaign(uuid,uuid,text)'::regprocedure) INTO v;
    IF v IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION '184: stop_dispatch_campaign devolve %, esperado boolean', v; END IF;
  END IF;
  IF to_regprocedure('wacrm.resume_dispatch_campaign(uuid,uuid)') IS NOT NULL THEN
    SELECT pg_get_function_result('wacrm.resume_dispatch_campaign(uuid,uuid)'::regprocedure) INTO v;
    IF v IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION '184: resume_dispatch_campaign devolve %, esperado integer', v; END IF;
  END IF;
END $$;

-- ---------- F4. Locks ----------
CREATE OR REPLACE FUNCTION wacrm.try_acquire_cron_lock(
  p_name TEXT,
  p_owner_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 90
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_owner TEXT;
  v_ttl INTEGER;
BEGIN
  v_ttl := LEAST(GREATEST(COALESCE(p_ttl_seconds, 90), 30), 3600);

  INSERT INTO wacrm.cron_locks (name, owner_id, acquired_at, expires_at)
  VALUES (p_name, p_owner_id, now(), now() + make_interval(secs => v_ttl))
  ON CONFLICT (name) DO UPDATE
  SET owner_id = EXCLUDED.owner_id,
      acquired_at = now(),
      expires_at = EXCLUDED.expires_at
  WHERE wacrm.cron_locks.expires_at <= now()
  RETURNING owner_id INTO v_owner;

  RETURN COALESCE(v_owner = p_owner_id, false);
END;
$$;

-- A 2 argumentos sai (senão a chamada por nome ficaria ambígua com a nova de 3 e valor padrão).
DROP FUNCTION IF EXISTS wacrm.renew_cron_lock(text, text);
CREATE OR REPLACE FUNCTION wacrm.renew_cron_lock(p_name text, p_owner text, p_ttl_seconds integer DEFAULT 90)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE affected integer;
BEGIN
  UPDATE wacrm.cron_locks
  SET expires_at = clock_timestamp() + make_interval(secs => LEAST(GREATEST(COALESCE(p_ttl_seconds, 90), 30), 3600))
  WHERE name = p_name
    AND owner_id = p_owner
    AND expires_at > clock_timestamp();

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

-- ---------- F5. Jobs de movimentação de itens ----------
CREATE TABLE IF NOT EXISTS wacrm.dispatch_campaign_moves (
  campaign_id uuid PRIMARY KEY,
  action      text NOT NULL CHECK (action IN ('pause', 'stop', 'resume', 'resume_keep')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wacrm.dispatch_campaign_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.dispatch_campaign_moves FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.dispatch_campaign_moves TO service_role;

CREATE OR REPLACE FUNCTION wacrm.stop_dispatch_campaign(
  p_campaign_id uuid,
  p_account_id uuid,
  p_action text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_status text;
BEGIN
  IF p_action NOT IN ('pause', 'stop') THEN
    RAISE EXCEPTION 'Invalid campaign action';
  END IF;

  SELECT status INTO v_status
  FROM wacrm.campaigns
  WHERE id = p_campaign_id
    AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;
  IF p_action = 'pause' AND v_status <> 'em_execucao' THEN RETURN false; END IF;

  -- Só o status: a partir do commit nenhum claim novo enxerga a campanha (exige 'em_execucao').
  UPDATE wacrm.campaigns
  SET status = CASE WHEN p_action = 'pause' THEN 'pausada' ELSE 'encerrada' END
  WHERE id = p_campaign_id;

  INSERT INTO wacrm.dispatch_campaign_moves (campaign_id, action)
  VALUES (p_campaign_id, p_action)
  ON CONFLICT (campaign_id) DO UPDATE SET action = EXCLUDED.action, updated_at = now();

  RETURN true;
END;
$$;

-- Retomada comum (reagenda tudo para "agora", em lotes) e retomada que preserva o scheduled_at do reflow (campanha em lote).
CREATE OR REPLACE FUNCTION wacrm.resume_dispatch_campaign(p_campaign_id uuid, p_account_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_count integer;
BEGIN
  SELECT status INTO v_status
  FROM wacrm.campaigns
  WHERE id = p_campaign_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'pausada' THEN RETURN NULL; END IF;

  -- Itens a (re)enfileirar: os já pausados + os que a pausa ainda não alcançou.
  SELECT count(*)::integer INTO v_count
  FROM wacrm.disp_message_queue
  WHERE campaign_id = p_campaign_id AND status IN ('pausado', 'agendado', 'pendente');

  UPDATE wacrm.campaigns SET status = 'em_execucao', next_batch_at = NULL WHERE id = p_campaign_id;

  INSERT INTO wacrm.dispatch_campaign_moves (campaign_id, action)
  VALUES (p_campaign_id, 'resume')
  ON CONFLICT (campaign_id) DO UPDATE SET action = EXCLUDED.action, updated_at = now();

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.resume_dispatch_campaign_keep_schedule(p_campaign_id uuid, p_account_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_count integer;
BEGIN
  SELECT status INTO v_status
  FROM wacrm.campaigns
  WHERE id = p_campaign_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'pausada' THEN RETURN NULL; END IF;

  SELECT count(*)::integer INTO v_count
  FROM wacrm.disp_message_queue
  WHERE campaign_id = p_campaign_id AND status IN ('pausado', 'agendado', 'pendente');

  UPDATE wacrm.campaigns SET status = 'em_execucao', next_batch_at = NULL WHERE id = p_campaign_id;

  INSERT INTO wacrm.dispatch_campaign_moves (campaign_id, action)
  VALUES (p_campaign_id, 'resume_keep')
  ON CONFLICT (campaign_id) DO UPDATE SET action = EXCLUDED.action, updated_at = now();

  RETURN v_count;
END;
$$;

-- Move os itens em lotes curtos. Devolve quantos itens moveu nesta chamada. Chamar repetidamente (rota e cron) até 0.
CREATE OR REPLACE FUNCTION wacrm.process_dispatch_campaign_moves(
  p_campaign_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 5000,
  p_max_jobs integer DEFAULT 10
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job record;
  v_status text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 20000);
  v_moved integer;
  v_total integer := 0;
  v_remaining boolean;
BEGIN
  FOR v_job IN
    SELECT campaign_id, action
    FROM wacrm.dispatch_campaign_moves
    WHERE p_campaign_id IS NULL OR campaign_id = p_campaign_id
    ORDER BY created_at
    LIMIT GREATEST(COALESCE(p_max_jobs, 10), 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT status INTO v_status FROM wacrm.campaigns WHERE id = v_job.campaign_id;

    -- Job obsoleto (campanha sumiu ou o status já não corresponde à ação — outro job a substituiu): descarta.
    IF v_status IS NULL
       OR (v_job.action = 'pause' AND v_status <> 'pausada')
       OR (v_job.action = 'stop' AND v_status <> 'encerrada')
       OR (v_job.action IN ('resume', 'resume_keep') AND v_status <> 'em_execucao')
    THEN
      DELETE FROM wacrm.dispatch_campaign_moves WHERE campaign_id = v_job.campaign_id AND action = v_job.action;
      CONTINUE;
    END IF;

    IF v_job.action = 'pause' THEN
      WITH picked AS (
        SELECT id FROM wacrm.disp_message_queue
        WHERE campaign_id = v_job.campaign_id AND status IN ('agendado', 'pendente')
        LIMIT v_limit FOR UPDATE SKIP LOCKED
      )
      UPDATE wacrm.disp_message_queue q SET status = 'pausado' FROM picked WHERE q.id = picked.id;
      GET DIAGNOSTICS v_moved = ROW_COUNT;
      SELECT EXISTS (SELECT 1 FROM wacrm.disp_message_queue WHERE campaign_id = v_job.campaign_id AND status IN ('agendado', 'pendente'))
        INTO v_remaining;
    ELSIF v_job.action = 'stop' THEN
      WITH picked AS (
        SELECT id FROM wacrm.disp_message_queue
        WHERE campaign_id = v_job.campaign_id AND status IN ('agendado', 'pendente', 'pausado')
        LIMIT v_limit FOR UPDATE SKIP LOCKED
      )
      UPDATE wacrm.disp_message_queue q SET status = 'cancelado' FROM picked WHERE q.id = picked.id;
      GET DIAGNOSTICS v_moved = ROW_COUNT;
      SELECT EXISTS (SELECT 1 FROM wacrm.disp_message_queue WHERE campaign_id = v_job.campaign_id AND status IN ('agendado', 'pendente', 'pausado'))
        INTO v_remaining;
    ELSE
      -- resume / resume_keep: pausado → agendado, na ordem original da fila.
      WITH picked AS (
        SELECT id FROM wacrm.disp_message_queue
        WHERE campaign_id = v_job.campaign_id AND status = 'pausado'
        ORDER BY scheduled_at NULLS FIRST, id
        LIMIT v_limit FOR UPDATE SKIP LOCKED
      )
      UPDATE wacrm.disp_message_queue q
      SET status = 'agendado',
          scheduled_at = CASE WHEN v_job.action = 'resume' THEN clock_timestamp()
                              ELSE COALESCE(q.scheduled_at, clock_timestamp()) END
      FROM picked WHERE q.id = picked.id;
      GET DIAGNOSTICS v_moved = ROW_COUNT;
      SELECT EXISTS (SELECT 1 FROM wacrm.disp_message_queue WHERE campaign_id = v_job.campaign_id AND status = 'pausado')
        INTO v_remaining;
    END IF;

    v_total := v_total + v_moved;
    -- Só encerra o job quando não resta item a mover (linhas travadas por outro processo ficam para a próxima chamada).
    IF NOT v_remaining THEN
      DELETE FROM wacrm.dispatch_campaign_moves WHERE campaign_id = v_job.campaign_id AND action = v_job.action;
    END IF;
  END LOOP;

  RETURN v_total;
END;
$$;

-- ---------- Permissões (só service_role) ----------
REVOKE ALL ON FUNCTION wacrm.try_acquire_cron_lock(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.try_acquire_cron_lock(text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.renew_cron_lock(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.renew_cron_lock(text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.stop_dispatch_campaign(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.stop_dispatch_campaign(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION wacrm.resume_dispatch_campaign(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.resume_dispatch_campaign(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION wacrm.resume_dispatch_campaign_keep_schedule(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.resume_dispatch_campaign_keep_schedule(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION wacrm.process_dispatch_campaign_moves(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.process_dispatch_campaign_moves(uuid, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
