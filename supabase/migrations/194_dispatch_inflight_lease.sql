-- ============================================================
-- 194_dispatch_inflight_lease.sql   (PRD 11, F14 — heartbeat dos itens em voo)
--
-- Problema: o watchdog (recoverStaleSendingReservations) tratava QUALQUER item 'enviando' com updated_at > 2 min como
-- "resultado externo não confirmado" (erro permanente, sem reenvio) sem saber se o envio ainda estava VIVO. Com tick
-- encadeado / worker (PRD 12), um envio lento mas legítimo (a Meta demorando) virava "incerto" por engano.
--
-- O que esta migration faz:
--   disp_message_queue.inflight_until (timestamptz, NULL) — LEASE do item em voo.
--   1) o claim (claim_dispatch_item_capped, usado também por claim_dispatch_item, e o claim em lote claim_dispatch_batch,
--      188 — atrás de DISPARADOR_BATCH_CLAIM) grava inflight_until = agora + 120 s ao marcar 'enviando';
--   2) quem envia RENOVA o lease (app, a cada 30 s, enquanto espera a Meta) — não é função do banco;
--   3) o watchdog só age em item cujo lease está VENCIDO (ou nulo = item antigo/anterior à migration: comportamento atual).
--
-- COMO O SQL DO CLAIM É ALTERADO: como na 192, em vez de reescrever as funções (o corpo de produção pode divergir dos
-- arquivos), este script LÊ a definição viva (pg_get_functiondef), troca o trecho
--     SET status = 'enviando', updated_at = clock_timestamp()
-- por
--     SET status = 'enviando', updated_at = clock_timestamp(), inflight_until = clock_timestamp() + interval '120 seconds'
-- e recria a função. Se não achar o trecho em uma função, ABORTA a transação sem alterar nada (a coluna também não fica):
-- nesse caso, avise para ajustar este arquivo. Já aplicado (tem 'inflight_until' na definição) = pula, sem erro.
--
-- PRÉ-CHECK (rodar antes e conferir):
--   SELECT to_regclass('wacrm.disp_message_queue');                                          -- não nulo
--   SELECT pg_get_functiondef('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure);
--     -- procure "SET status = 'enviando'," seguido de "updated_at = clock_timestamp()" (e "inflight_until" NÃO deve existir)
--   SELECT pg_get_functiondef('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)'::regprocedure);   -- se a 188 estiver aplicada
--     -- procure "SET status = 'enviando', updated_at = clock_timestamp()"
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='wacrm' AND table_name='disp_message_queue' AND column_name='inflight_until';     -- 0 linhas antes
-- DEPOIS: rodar a 194b (índice parcial, CONCURRENTLY, SOZINHA).
-- ORDEM: pode ser aplicada ANTES ou DEPOIS do deploy. Sem a coluna o app e o watchdog seguem no comportamento atual
-- (42703/PGRST204 detectado); com a coluna, o lease só passa a valer para os claims feitos DEPOIS da migration (itens
-- 'enviando' de antes têm inflight_until nulo e são tratados como hoje).
-- ROLLBACK: reaplicar a definição anterior das duas funções (guarde o pg_get_functiondef do pré-check) e
--   ALTER TABLE wacrm.disp_message_queue DROP COLUMN IF EXISTS inflight_until;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL THEN
    RAISE EXCEPTION '194: falta wacrm.disp_message_queue';
  END IF;
  IF to_regprocedure('wacrm.claim_dispatch_item_capped(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION '194: falta wacrm.claim_dispatch_item_capped(uuid,integer) (migration 164/167/186)';
  END IF;
END $$;

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS inflight_until timestamptz;

-- Troca o UPDATE do claim para gravar o lease junto.
CREATE OR REPLACE FUNCTION pg_temp.patch_claim_lease(p_proc regprocedure)
RETURNS boolean
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_def text := pg_catalog.pg_get_functiondef(p_proc);
  v_new text;
  v_re  text := '(SET\s+status\s*=\s*''enviando''\s*,\s*updated_at\s*=\s*clock_timestamp\(\))';
BEGIN
  IF v_def ~* 'inflight_until' THEN
    RETURN false; -- já aplicado
  END IF;
  IF v_def !~* v_re THEN
    RAISE EXCEPTION '194: trecho "SET status = ''enviando'', updated_at = clock_timestamp()" não encontrado em % — nada foi alterado; ajuste o arquivo', p_proc;
  END IF;
  v_new := pg_catalog.regexp_replace(
    v_def,
    v_re,
    E'\\1, inflight_until = clock_timestamp() + interval ''120 seconds''',
    'i'
  );
  IF v_new = v_def THEN
    RAISE EXCEPTION '194: substituição sem efeito em %', p_proc;
  END IF;
  EXECUTE v_new;
  RETURN true;
END;
$fn$;

SELECT pg_temp.patch_claim_lease('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure);

DO $$
BEGIN
  -- O claim em lote só existe depois da 188; sem ela, só o claim por item é ajustado.
  IF to_regprocedure('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)') IS NOT NULL THEN
    PERFORM pg_temp.patch_claim_lease('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)'::regprocedure);
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
