-- ============================================================
-- 362_webhook_recipient_funnel.sql   (API pública Onda 1, bloco B — decisão do dono 15/10, item 5 = c)
--
-- O QUE FAZ: o evento `recipient.funnel` (webhook de saída assinado) quando um destinatário de campanha avança no funil do link rastreado
-- (UTMpay, migration 356): clicou (`clicked`), fechou acordo (`closed`) e pagou (`paid`), com a ATRIBUIÇÃO (`direct` | `ai` | `human`) e o
-- atendente. É a "baixa" do ERP sem polling.
--   wacrm.webhook_on_utmpay_link()  + trigger trg_webhook_utmpay_link (AFTER UPDATE OF clicou_em, fechou_em, pagou_em, atribuicao em
--   wacrm.utmpay_links). Pega QUALQUER caminho que marca o funil (evento do UTMpay, detecção por consulta à API DDM, reconferência do paid).
--     clicked  quando clicou_em passa de NULL para preenchido.
--     closed   quando fechou_em está preenchido E a atribuição já foi calculada (a atribuição pode chegar num UPDATE seguinte ao do marco:
--              o evento sai quando os dois existem — uma vez só).
--     paid     quando pagou_em (CONFIRMADO na API DDM, nunca só o evento do UTMpay) está preenchido E há atribuição.
--   `event_id` determinístico por (tid, etapa): cada etapa sai UMA vez por destinatário, e reemitir é seguro (idempotente por endpoint).
--   Só trabalha se a conta tem endpoint ativo assinando `recipient.funnel`; à prova de falha (EXCEPTION → WARNING; nunca derruba a
--   gravação do funil). tid = id do item da fila (356): o contexto (campanha, external_id, telefone, referência) vem de
--   wacrm.webhook_recipient_payload (361). Link sem item da fila (tid que não é UUID de item) não emite.
-- DADO PESSOAL: telefone do destinatário (nunca CPF). Volume e teto: ver 360.
-- COMPATIBILIDADE: sem esta migration só falta o evento de funil; tudo o mais segue.
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.utmpay_links');                                                                       -- não nulo (356)
--   SELECT to_regprocedure('wacrm.webhook_recipient_payload(wacrm.disp_message_queue)');                            -- existe (361)
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='utmpay_links'
--      AND column_name IN ('tid','account_id','clicou_em','fechou_em','pagou_em','atribuicao','atendente_id');     -- 7 linhas
-- VERIFICAÇÃO (depois): SELECT tgname FROM pg_trigger WHERE tgname = 'trg_webhook_utmpay_link' AND NOT tgisinternal;  -- 1 linha
-- ORDEM: depois da 204, 356 e 361. Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_webhook_utmpay_link ON wacrm.utmpay_links;
--   DROP FUNCTION IF EXISTS wacrm.webhook_on_utmpay_link();
--   DELETE FROM wacrm.schema_migrations WHERE version = '362_webhook_recipient_funnel';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.utmpay_links') IS NULL THEN
    RAISE EXCEPTION '362: falta wacrm.utmpay_links (migration 356) — nada foi alterado';
  END IF;
  IF to_regprocedure('wacrm.webhook_recipient_payload(wacrm.disp_message_queue)') IS NULL THEN
    RAISE EXCEPTION '362: falta wacrm.webhook_recipient_payload (migration 361) — aplique a 361 antes';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'utmpay_links'
        AND column_name IN ('tid', 'account_id', 'clicou_em', 'fechou_em', 'pagou_em', 'atribuicao', 'atendente_id')) <> 7 THEN
    RAISE EXCEPTION '362: wacrm.utmpay_links com colunas inesperadas — confira o schema vivo';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.webhook_on_utmpay_link()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_item wacrm.disp_message_queue%ROWTYPE;
  v_attr text;
  v_step text;
  v_at timestamptz;
  v_steps text[] := ARRAY[]::text[];
BEGIN
  IF NEW.account_id IS NULL OR NOT wacrm.webhook_endpoint_listens(NEW.account_id, 'recipient.funnel') THEN RETURN NULL; END IF;
  IF NEW.tid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;

  IF NEW.clicou_em IS NOT NULL AND OLD.clicou_em IS NULL THEN v_steps := array_append(v_steps, 'clicked'); END IF;
  IF NEW.fechou_em IS NOT NULL AND NEW.atribuicao IS NOT NULL AND (OLD.fechou_em IS NULL OR OLD.atribuicao IS NULL) THEN v_steps := array_append(v_steps, 'closed'); END IF;
  IF NEW.pagou_em IS NOT NULL AND NEW.atribuicao IS NOT NULL AND (OLD.pagou_em IS NULL OR OLD.atribuicao IS NULL) THEN v_steps := array_append(v_steps, 'paid'); END IF;
  IF cardinality(v_steps) = 0 THEN RETURN NULL; END IF;

  SELECT * INTO v_item FROM wacrm.disp_message_queue q WHERE q.id = NEW.tid::uuid AND q.account_id = NEW.account_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_attr := CASE NEW.atribuicao WHEN 'direto' THEN 'direct' WHEN 'ia' THEN 'ai' WHEN 'humano' THEN 'human' ELSE NULL END;

  FOREACH v_step IN ARRAY v_steps LOOP
    v_at := CASE v_step WHEN 'clicked' THEN NEW.clicou_em WHEN 'closed' THEN NEW.fechou_em ELSE NEW.pagou_em END;
    PERFORM wacrm.enqueue_webhook_event(NEW.account_id, 'recipient.funnel',
      md5('recipient.funnel:' || NEW.tid || ':' || v_step)::uuid,
      wacrm.webhook_recipient_payload(v_item) || jsonb_build_object(
        'step', v_step,
        'attribution', CASE WHEN v_step = 'clicked' THEN NULL ELSE v_attr END,
        'attendant_id', CASE WHEN v_step = 'clicked' THEN NULL ELSE NEW.atendente_id END,
        'at', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_utmpay_link falhou: %', SQLERRM;  -- nunca derruba a gravação do funil
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.webhook_on_utmpay_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_webhook_utmpay_link ON wacrm.utmpay_links;
CREATE TRIGGER trg_webhook_utmpay_link AFTER UPDATE OF clicou_em, fechou_em, pagou_em, atribuicao ON wacrm.utmpay_links
  FOR EACH ROW EXECUTE FUNCTION wacrm.webhook_on_utmpay_link();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('362_webhook_recipient_funnel') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
