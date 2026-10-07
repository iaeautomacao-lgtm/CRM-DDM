-- ============================================================
-- 187_disp_queue_erro_codigo.sql
--
-- disp_message_queue.erro_codigo (integer): código de erro da Meta do item, extraído do texto de `erro`.
-- Hoje o código só existe DENTRO do texto ("… (code 131049)" / "(#131049) …"), então filtrar/contar por
-- código exigia ILIKE no texto. Com a coluna (+ o índice parcial da 187b) as telas de erros e o
-- resumo por código ficam baratos com 100 mil itens.
--
-- Como a coluna é mantida: TRIGGER BEFORE INSERT/UPDATE OF erro. Todo caminho que grava `erro`
-- (processQueue/markQueueError, watchdog, apply_dispatch_status, confirm_pending_meta_131026, startCampaign,
-- API v1…) passa a preencher erro_codigo sem alterar o código desses caminhos — e sem depender da ordem
-- "migration antes/depois do deploy" (o app nunca escreve a coluna diretamente).
-- A regex é a MESMA de extrairCodigoMetaErro (src/lib/disparador/normalize-meta-error.ts):
-- primeiro "code <n>", senão "(#<n>)"; sem código (erros locais, WAHA) = NULL.
--
-- Backfill: wacrm.backfill_erro_codigo(p_limit, p_after) trata UM lote por chamada (keyset por id) —
-- rode repetidamente (ver scripts/backfill-erro-codigo.mjs, ou no SQL Editor:
--   SELECT * FROM wacrm.backfill_erro_codigo(5000, NULL);
--   SELECT * FROM wacrm.backfill_erro_codigo(5000, '<last_id da chamada anterior>'); … até last_id nulo).
-- NÃO é um UPDATE único de milhões de linhas. Preserva updated_at (a recuperação de itens presos e a
-- janela da pausa automática dependem dele).
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.disp_message_queue');                            -- não nulo
--   SELECT tgname FROM pg_trigger
--     WHERE tgrelid = 'wacrm.disp_message_queue'::regclass AND NOT tgisinternal;
--   -- se existir um trigger que sobrescreve updated_at em todo UPDATE (ex.: set_updated_at), o backfill
--   -- bumparia updated_at das linhas antigas: desligue-o durante o backfill ou avise antes de rodar.
--
-- DEPOIS: rodar a 187b (índice parcial, CONCURRENTLY, SOZINHA).
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL THEN
    RAISE EXCEPTION '187: wacrm.disp_message_queue não existe';
  END IF;
END $$;

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS erro_codigo integer;

-- Mesma regra de extrairCodigoMetaErro (JS): "code <n>" primeiro, senão "(#<n>)".
CREATE OR REPLACE FUNCTION wacrm.extract_meta_error_code(p_erro text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT COALESCE(
    NULLIF(substring(p_erro FROM 'code ([0-9]{1,9})'), '')::integer,
    NULLIF(substring(p_erro FROM '\(#([0-9]{1,9})\)'), '')::integer
  );
$$;

CREATE OR REPLACE FUNCTION wacrm.trg_disp_queue_erro_codigo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.erro IS NOT NULL AND NEW.erro_codigo IS NULL THEN
      NEW.erro_codigo := wacrm.extract_meta_error_code(NEW.erro);
    END IF;
  ELSIF NEW.erro IS DISTINCT FROM OLD.erro THEN
    -- Texto novo (inclui erro limpo = NULL quando o item é enviado/recuperado).
    NEW.erro_codigo := CASE WHEN NEW.erro IS NULL THEN NULL ELSE wacrm.extract_meta_error_code(NEW.erro) END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_disp_queue_erro_codigo ON wacrm.disp_message_queue;
CREATE TRIGGER trg_disp_queue_erro_codigo
  BEFORE INSERT OR UPDATE OF erro ON wacrm.disp_message_queue
  FOR EACH ROW EXECUTE FUNCTION wacrm.trg_disp_queue_erro_codigo();

-- Backfill em lotes (um lote por chamada). Devolve quantas linhas olhou, quantas preencheu e o último id
-- do lote (cursor da próxima chamada; NULL = terminou).
CREATE OR REPLACE FUNCTION wacrm.backfill_erro_codigo(
  p_limit integer DEFAULT 5000,
  p_after uuid DEFAULT NULL
)
RETURNS TABLE(scanned integer, updated integer, last_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scanned integer;
  v_updated integer;
  v_last uuid;
BEGIN
  WITH batch AS (
    SELECT q.id
    FROM wacrm.disp_message_queue q
    WHERE (p_after IS NULL OR q.id > p_after)
      AND q.erro IS NOT NULL
      AND q.erro_codigo IS NULL
    ORDER BY q.id
    LIMIT GREATEST(COALESCE(p_limit, 5000), 1)
  ),
  upd AS (
    UPDATE wacrm.disp_message_queue q
    SET erro_codigo = wacrm.extract_meta_error_code(q.erro),
        updated_at = q.updated_at           -- preserva (janela da pausa automática, itens presos)
    FROM batch b
    WHERE q.id = b.id
      AND wacrm.extract_meta_error_code(q.erro) IS NOT NULL
    RETURNING q.id
  )
  SELECT (SELECT count(*)::integer FROM batch),
         (SELECT count(*)::integer FROM upd),
         (SELECT b.id FROM batch b ORDER BY b.id DESC LIMIT 1)
  INTO v_scanned, v_updated, v_last;

  RETURN QUERY SELECT v_scanned, v_updated, v_last;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.extract_meta_error_code(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.extract_meta_error_code(text) TO service_role;
REVOKE ALL ON FUNCTION wacrm.backfill_erro_codigo(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.backfill_erro_codigo(integer, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
