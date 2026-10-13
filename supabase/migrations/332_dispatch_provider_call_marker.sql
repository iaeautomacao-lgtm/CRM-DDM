-- ============================================================
-- 332_dispatch_provider_call_marker.sql   (AUDIT-DISPARADOR D-02 — restart sem perder mensagem)
--
-- Problema: num restart do Passenger no meio do tick, todo item `enviando` sem recibo e com lease vencido virava "erro permanente —
-- resultado externo não confirmado" (reconcile-unknown-provider-outcomes.ts), inclusive os que NUNCA chegaram à Meta/WAHA.
-- Não duplicava, mas perdia a mensagem. Agora cada item diz em que ponto estava:
--
--   disp_message_queue.provider_call_started_at  timestamptz NULL  (sem default: só metadado, sem reescrever a tabela)
--     '-infinity'  reivindicado e a chamada ao provedor ainda NÃO começou → o watchdog devolve à fila (nunca saiu, reenviar é seguro);
--     timestamp    a chamada começou (o app grava IMEDIATAMENTE antes do POST, com compare-and-set) → o watchdog segue a regra de
--                  sempre: erro permanente "não confirmado", NUNCA reenviar;
--     NULL         linha anterior à migration → regra de sempre (incerto).
--   Trigger BEFORE UPDATE OF status (só na transição para 'enviando', ou seja, no claim): grava '-infinity'. Assim nenhuma das funções
--   de claim (item/lote) precisa ser alterada e um marcador antigo nunca "vaza" para a próxima tentativa.
--
-- ⚠️ ORDEM (importante): (1) FAZER O DEPLOY do código novo, que tolera a coluna ausente; (2) aplicar esta migration depois que NENHUM
-- processo da versão antiga estiver rodando. Aplicar antes do deploy faria o código antigo reivindicar itens (marcados '-infinity')
-- e enviá-los SEM gravar o marcador: um restart nesse intervalo devolveria à fila um item já enviado (duplicidade). O código novo
-- reavalia a presença da coluna a cada 5 min, então o restart pós-migration não é obrigatório.
--
-- CUSTO: um trigger de linha com WHEN na tabela quente, executado só no claim (~microssegundos); ADD COLUMN NULL sem default é
-- instantâneo; o UPDATE do marcador por envio não muda coluna indexada (elegível a HOT).
--
-- PRÉ-CHECK:  SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='disp_message_queue'
--              AND column_name='provider_call_started_at';   -- 0 linhas
-- VERIFICAÇÃO: SELECT tgname FROM pg_trigger WHERE tgname = 'trg_dmq_provider_call_marker';   -- 1 linha
-- ROLLBACK:   DROP TRIGGER IF EXISTS trg_dmq_provider_call_marker ON wacrm.disp_message_queue;
--             DROP FUNCTION IF EXISTS wacrm.dmq_reset_provider_call_marker();
--             ALTER TABLE wacrm.disp_message_queue DROP COLUMN IF EXISTS provider_call_started_at;   -- (código novo tolera a ausência)
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL THEN
    RAISE EXCEPTION '332: falta wacrm.disp_message_queue';
  END IF;
END $$;

ALTER TABLE wacrm.disp_message_queue ADD COLUMN IF NOT EXISTS provider_call_started_at timestamptz;

CREATE OR REPLACE FUNCTION wacrm.dmq_reset_provider_call_marker()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.provider_call_started_at := '-infinity'::timestamptz;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dmq_provider_call_marker ON wacrm.disp_message_queue;
CREATE TRIGGER trg_dmq_provider_call_marker
  BEFORE UPDATE OF status ON wacrm.disp_message_queue
  FOR EACH ROW
  WHEN (NEW.status = 'enviando' AND OLD.status IS DISTINCT FROM 'enviando')
  EXECUTE FUNCTION wacrm.dmq_reset_provider_call_marker();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('332_dispatch_provider_call_marker') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
