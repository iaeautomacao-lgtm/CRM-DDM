-- ============================================================
-- 192_dispatch_channel_paused.sql   (P1-6a — pausar/retomar um número pelo front)
--
-- dispatch_channel_limits.paused (boolean, padrão false): número pausado NÃO recebe claim — nem pelo claim por
-- item (claim_dispatch_item_capped, usado também por claim_dispatch_item) nem pelo claim em lote
-- (claim_dispatch_batch, 188). Os itens ficam 'agendado' e saem sozinhos quando o número é retomado; nada é
-- cancelado nem reenviado. Vale no PRÓXIMO tick (o cron lê a linha a cada tick; o claim confere no banco).
-- Itens já 'enviando' terminam normalmente (a pausa só impede novos claims).
--
-- COMO O SQL DO CLAIM É ALTERADO: em vez de reescrever as duas funções (o corpo de produção pode divergir
-- dos arquivos), este script LÊ a definição viva (pg_get_functiondef), insere UMA checagem antes da leitura
-- dos limites do canal e recria a função. Se não achar o ponto de inserção, ABORTA sem alterar nada
-- (a coluna fica; as funções continuam como estavam) — nesse caso, avise para ajustar este arquivo.
-- A checagem: IF EXISTS (SELECT 1 FROM wacrm.dispatch_channel_limits WHERE session_id = … AND paused)
--             THEN RETURN false/vazio; END IF;   (uma leitura por chave primária)
--
-- PRÉ-CHECK (rodar antes e conferir):
--   SELECT to_regclass('wacrm.dispatch_channel_limits');                                   -- não nulo
--   SELECT pg_get_functiondef('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure);
--     -- procure "SELECT max_in_flight, hourly_limit INTO v_concurrency, v_channel_limit" (e "AND paused" NÃO deve existir)
--   SELECT pg_get_functiondef('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)'::regprocedure);  -- 188 aplicada
--   SELECT count(*) FROM wacrm.dispatch_channel_limits;                                    -- só para saber quantas linhas existem
-- ORDEM: aplicar ANTES ou DEPOIS do deploy (o app detecta a ausência da coluna e desliga o botão de pausa).
-- Idempotente — pode rodar mais de uma vez (a segunda não muda nada).
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.dispatch_channel_limits') IS NULL THEN
    RAISE EXCEPTION '192: falta wacrm.dispatch_channel_limits (migration 118/133)';
  END IF;
  IF to_regprocedure('wacrm.claim_dispatch_item_capped(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION '192: falta wacrm.claim_dispatch_item_capped(uuid,integer) (migration 164/167/186)';
  END IF;
END $$;

ALTER TABLE wacrm.dispatch_channel_limits
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

-- Insere a checagem de pausa antes da leitura dos limites do canal.
-- p_key  : expressão do session_id dentro da função (v_item.session_id | p_session_id)
-- p_ret  : comando de saída ('RETURN false' | 'RETURN')
CREATE OR REPLACE FUNCTION pg_temp.patch_claim_paused(p_proc regprocedure, p_key text, p_ret text)
RETURNS boolean
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_def text := pg_catalog.pg_get_functiondef(p_proc);
  v_new text;
  v_re  text := '(SELECT\s+max_in_flight,\s*hourly_limit\s+INTO\s+v_concurrency,\s*v_channel_limit)';
BEGIN
  IF v_def ~* 'dispatch_channel_limits\s+WHERE\s+session_id\s*=\s*[a-z_.]+\s+AND\s+paused' THEN
    RETURN false; -- já aplicado
  END IF;
  IF v_def !~* v_re THEN
    RAISE EXCEPTION '192: ponto de inserção não encontrado em % — nada foi alterado; ajuste o arquivo', p_proc;
  END IF;
  v_new := pg_catalog.regexp_replace(
    v_def,
    v_re,
    pg_catalog.format(
      E'IF EXISTS (SELECT 1 FROM wacrm.dispatch_channel_limits WHERE session_id = %s AND paused) THEN %s; END IF;\n  \\1',
      p_key,
      p_ret
    ),
    'i'
  );
  IF v_new = v_def THEN
    RAISE EXCEPTION '192: substituição sem efeito em %', p_proc;
  END IF;
  EXECUTE v_new;
  RETURN true;
END;
$fn$;

SELECT pg_temp.patch_claim_paused('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure, 'v_item.session_id', 'RETURN false');

DO $$
BEGIN
  -- O claim em lote só existe depois da 188; sem ela, só o claim por item é ajustado.
  IF to_regprocedure('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)') IS NOT NULL THEN
    PERFORM pg_temp.patch_claim_paused('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)'::regprocedure, 'p_session_id', 'RETURN');
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
