-- ============================================================
-- 358_campaign_add_recipients.sql   (API pública Onda 1, bloco A3 — adicionar contatos a campanha existente; decisões do dono de 15/10)
--
-- O QUE FAZ:
--   wacrm.add_campaign_recipients(conta, campanha, linhas, teto): insere um bloco de destinatários numa campanha CRIADA PELA API
--   (source = 'api_v1') que esteja em execução ou pausada, com o MESMO lock de campanha que pausa/retoma/encerra (118) e que a conclusão
--   (complete_dispatch_campaign) usa — então a campanha não conclui "no meio" da inserção. No mesmo comando:
--     - recusa se a soma de itens da campanha passaria do teto (50.000 pelo app);
--     - deduplica contra o que já está na campanha (wacrm.phone_key: com/sem 55, com/sem 9º dígito) e dentro do bloco;
--     - cria os itens 'agendado' (campanha em execução) ou 'pausado' (campanha pausada: voltam a 'agendado' na retomada);
--     - soma campaign_metrics.total_contatos.
--   Devolve jsonb: {added, duplicates, total} ou {error: 'not_api_campaign' | 'status' | 'cap', ...}; NULL se a campanha não é da conta.
--   O app chama em blocos de 1.000 linhas; se um bloco falhar, os anteriores ficam e REPETIR a chamada completa é seguro (a deduplicação
--   contra a campanha só acrescenta o que faltou).
-- COMPATIBILIDADE: função nova, nenhuma tabela/coluna muda. Sem ela a rota responde 503 e nada mais é afetado. Depois da 167 e da 357
--   (reference). Antes ou depois do deploy. Idempotente.
-- PRÉ-CHECK (rodar ANTES; schema vivo):
--   SELECT to_regprocedure('wacrm.phone_key(text)');                                                  -- não nulo (167)
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='disp_message_queue'
--     AND column_name IN ('reference','template_variables','template_name','template_language','media_url','tipo','session_id','scheduled_at');
--     -- 8 linhas (reference vem da 357)
--   SELECT to_regclass('wacrm.campaign_metrics');                                                      -- não nulo
-- VERIFICAÇÃO:
--   SELECT to_regprocedure('wacrm.add_campaign_recipients(uuid,uuid,jsonb,integer)');
--   SELECT version FROM wacrm.schema_migrations WHERE version = '358_campaign_add_recipients';
-- ROLLBACK (executável; o teste PGlite executa este bloco):
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.add_campaign_recipients(uuid, uuid, jsonb, integer);
--   DELETE FROM wacrm.schema_migrations WHERE version = '358_campaign_add_recipients';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL OR to_regclass('wacrm.disp_message_queue') IS NULL OR to_regclass('wacrm.campaign_metrics') IS NULL THEN
    RAISE EXCEPTION '358: faltam wacrm.campaigns/disp_message_queue/campaign_metrics';
  END IF;
  IF to_regprocedure('wacrm.phone_key(text)') IS NULL THEN
    RAISE EXCEPTION '358: falta wacrm.phone_key(text) (migration 167)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'disp_message_queue' AND column_name = 'reference') THEN
    RAISE EXCEPTION '358: falta disp_message_queue.reference — aplique a 357 antes';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.add_campaign_recipients(
  p_account uuid,
  p_campaign uuid,
  p_rows jsonb,
  p_cap integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_source text;
  v_total integer;
  v_in integer := COALESCE(jsonb_array_length(p_rows), 0);
  v_added integer;
BEGIN
  SELECT status, source INTO v_status, v_source FROM wacrm.campaigns WHERE id = p_campaign AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_source IS DISTINCT FROM 'api_v1' THEN RETURN jsonb_build_object('error', 'not_api_campaign'); END IF;
  IF v_status NOT IN ('em_execucao', 'pausada') THEN RETURN jsonb_build_object('error', 'status', 'status', v_status); END IF;

  SELECT count(*) INTO v_total FROM wacrm.disp_message_queue WHERE campaign_id = p_campaign;
  IF v_total + v_in > COALESCE(p_cap, 50000) THEN
    RETURN jsonb_build_object('error', 'cap', 'total', v_total, 'cap', COALESCE(p_cap, 50000));
  END IF;

  WITH incoming AS (
    SELECT r.*, wacrm.phone_key(r.mensagem_final) AS pkey
      FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(
        session_id uuid, mensagem_final text, tipo text, media_url text, scheduled_at timestamptz,
        template_name text, template_language text, template_variables jsonb, reference text)
  ), existing AS (
    SELECT DISTINCT wacrm.phone_key(q.mensagem_final) AS pkey
      FROM wacrm.disp_message_queue q WHERE q.campaign_id = p_campaign AND q.contact_id IS NULL
  ), fresh AS (
    SELECT DISTINCT ON (i.pkey) i.*
      FROM incoming i
     WHERE NOT EXISTS (SELECT 1 FROM existing e WHERE e.pkey = i.pkey)
     ORDER BY i.pkey, i.scheduled_at
  ), ins AS (
    INSERT INTO wacrm.disp_message_queue (campaign_id, account_id, contact_id, session_id, mensagem_final, status, tipo, media_url,
                                          scheduled_at, template_name, template_language, template_variables, reference)
    SELECT p_campaign, p_account, NULL, f.session_id, f.mensagem_final,
           CASE WHEN v_status = 'pausada' THEN 'pausado' ELSE 'agendado' END,
           f.tipo, f.media_url, f.scheduled_at, f.template_name, f.template_language, f.template_variables, f.reference
      FROM fresh f
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM ins;

  UPDATE wacrm.campaign_metrics SET total_contatos = COALESCE(total_contatos, 0) + v_added WHERE campaign_id = p_campaign;
  RETURN jsonb_build_object('added', v_added, 'duplicates', v_in - v_added, 'total', v_total + v_added);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.add_campaign_recipients(uuid, uuid, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.add_campaign_recipients(uuid, uuid, jsonb, integer) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('358_campaign_add_recipients') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
