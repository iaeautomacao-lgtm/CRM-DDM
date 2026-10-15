-- ============================================================
-- 357_campaign_api_control.sql   (API pública Onda 1, bloco A2 — controle de campanha; decisões do dono de 15/10)
--
-- O QUE FAZ:
--   1. disp_message_queue.cancel_reason  (por que o item foi cancelado: 'removed_api:paid', 'removed_api:other'…) e
--      disp_message_queue.reference      (texto opaco do integrador por contato, até 64 caracteres; permite tirar "o contrato X" sem CPF).
--   2. campaigns.pause_reason            (motivo da pausa manual/por API, legível no painel e na API);
--      campaigns.encerramento_motivo     ('cancelled' | 'cancelled_api'; NULL = concluída ou anterior a esta migration);
--      campaigns.slot_size / slot_interval_minutes  (o ritmo do create pela API, para "adicionar contatos" manter o mesmo espaçamento).
--   3. wacrm.remove_campaign_recipients(conta, campanha, chaves de telefone, referências, motivo): tira destinatários AINDA NÃO ENVIADOS da
--      campanha (agendado/pendente/pausado → cancelado), com lock da campanha (o mesmo das RPCs de pausa/retomada/encerramento da 118),
--      idempotente, e devolve o estado de cada chave/referência (removed | already_removed | in_flight | already_sent | not_found).
--      NÃO mexe na blacklist: remover quem pagou não é opt-out.
-- COMPATIBILIDADE: tudo nullable, sem default (instantâneo). O código funciona SEM esta migration: o create ignora slot_size/reference
--   (a reference exige a coluna e responde 503 clara se faltar), pause/cancel/resume não gravam motivo, e remove devolve 503 sem a RPC.
-- ORDEM: antes ou depois do deploy. Depois da 184. Idempotente. Sem CONCURRENTLY (nenhum índice novo: a RPC lê só os itens da campanha pelo índice
--   existente de campaign_id). Sem tabela nova ⇒ sem RLS/apply_mfa_policy a configurar.
-- PRÉ-CHECK (rodar ANTES; schema vivo):
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='disp_message_queue'
--     AND column_name IN ('cancel_reason','reference');                                                         -- 0 linhas na 1ª vez
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='campaigns'
--     AND column_name IN ('pause_reason','encerramento_motivo','slot_size','slot_interval_minutes');            -- 0 linhas na 1ª vez
--   SELECT to_regprocedure('wacrm.phone_key(text)'), to_regprocedure('wacrm.stop_dispatch_campaign(uuid,uuid,text)');   -- não nulos
--   SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='disp_message_queue'
--     AND column_name IN ('status','contact_id','mensagem_final','campaign_id','updated_at');                   -- confere os nomes usados na RPC
-- VERIFICAÇÃO:
--   SELECT to_regprocedure('wacrm.remove_campaign_recipients(uuid,uuid,text[],text[],text)');
--   SELECT version FROM wacrm.schema_migrations WHERE version = '357_campaign_api_control';
-- ROLLBACK (executável; o teste PGlite executa este bloco):
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.remove_campaign_recipients(uuid, uuid, text[], text[], text);
--   ALTER TABLE wacrm.disp_message_queue DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS reference;
--   ALTER TABLE wacrm.campaigns DROP COLUMN IF EXISTS pause_reason, DROP COLUMN IF EXISTS encerramento_motivo,
--     DROP COLUMN IF EXISTS slot_size, DROP COLUMN IF EXISTS slot_interval_minutes;
--   DELETE FROM wacrm.schema_migrations WHERE version = '357_campaign_api_control';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL OR to_regclass('wacrm.disp_message_queue') IS NULL THEN
    RAISE EXCEPTION '357: faltam wacrm.campaigns/disp_message_queue';
  END IF;
  IF to_regprocedure('wacrm.phone_key(text)') IS NULL THEN
    RAISE EXCEPTION '357: falta wacrm.phone_key(text) (migration 167)';
  END IF;
END $$;

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS reference text;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS encerramento_motivo text,
  ADD COLUMN IF NOT EXISTS slot_size integer,
  ADD COLUMN IF NOT EXISTS slot_interval_minutes integer;

-- Tira destinatários ainda não enviados. p_phone_keys = wacrm.phone_key() dos telefones (a rota resolve CPF → telefones do contato);
-- p_references = textos opacos gravados no create. Devolve NULL se a campanha não é da conta.
CREATE OR REPLACE FUNCTION wacrm.remove_campaign_recipients(
  p_account uuid,
  p_campaign uuid,
  p_phone_keys text[],
  p_references text[],
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason text := 'removed_api:' || COALESCE(NULLIF(btrim(p_reason), ''), 'other');
  v_removed integer;
  v_phones jsonb;
  v_refs jsonb;
BEGIN
  PERFORM 1 FROM wacrm.campaigns WHERE id = p_campaign AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Uma só leitura dos itens da campanha: casa por referência ou pela chave do telefone (externo: mensagem_final; contato: contacts.phone).
  -- O UPDATE e o resultado saem do mesmo comando (CTE), com o instantâneo de antes do cancelamento.
  WITH matched AS (
    SELECT q.id, q.status, q.cancel_reason, q.reference AS ref,
           wacrm.phone_key(CASE WHEN q.contact_id IS NULL THEN q.mensagem_final ELSE c.phone END) AS pkey
      FROM wacrm.disp_message_queue q
      LEFT JOIN wacrm.contacts c ON c.id = q.contact_id
     WHERE q.campaign_id = p_campaign
       AND ((q.reference IS NOT NULL AND q.reference = ANY (COALESCE(p_references, '{}')))
            OR wacrm.phone_key(CASE WHEN q.contact_id IS NULL THEN q.mensagem_final ELSE c.phone END) = ANY (COALESCE(p_phone_keys, '{}')))
  ), cancelled AS (
    UPDATE wacrm.disp_message_queue q
       SET status = 'cancelado', cancel_reason = v_reason, updated_at = clock_timestamp()
      FROM matched m
     WHERE q.id = m.id AND q.status IN ('agendado', 'pendente', 'pausado')
    RETURNING q.id
  ), items AS (
    SELECT m.*, (x.id IS NOT NULL) AS removed FROM matched m LEFT JOIN cancelled x ON x.id = m.id
  )
  SELECT (SELECT count(*) FROM cancelled),
         -- Estado por chave/referência: removed > in_flight > already_removed (cancelado por remoção ou com a campanha: não será enviado) > already_sent > not_found.
         (SELECT COALESCE(jsonb_object_agg(k, jsonb_build_object('status', st, 'items', n)), '{}'::jsonb) FROM (
            SELECT k,
                   CASE WHEN COALESCE(bool_or(i.removed), false) THEN 'removed'
                        WHEN COALESCE(bool_or(i.status = 'enviando'), false) THEN 'in_flight'
                        WHEN COALESCE(bool_or(i.cancel_reason LIKE 'removed_api:%' OR i.status = 'cancelado'), false) THEN 'already_removed'
                        WHEN count(i.id) > 0 THEN 'already_sent'
                        ELSE 'not_found' END AS st,
                   count(i.id) AS n
              FROM unnest(COALESCE(p_phone_keys, '{}')) AS k LEFT JOIN items i ON i.pkey = k GROUP BY k) t),
         (SELECT COALESCE(jsonb_object_agg(k, jsonb_build_object('status', st, 'items', n)), '{}'::jsonb) FROM (
            SELECT k,
                   CASE WHEN COALESCE(bool_or(i.removed), false) THEN 'removed'
                        WHEN COALESCE(bool_or(i.status = 'enviando'), false) THEN 'in_flight'
                        WHEN COALESCE(bool_or(i.cancel_reason LIKE 'removed_api:%' OR i.status = 'cancelado'), false) THEN 'already_removed'
                        WHEN count(i.id) > 0 THEN 'already_sent'
                        ELSE 'not_found' END AS st,
                   count(i.id) AS n
              FROM unnest(COALESCE(p_references, '{}')) AS k LEFT JOIN items i ON i.ref = k GROUP BY k) t)
    INTO v_removed, v_phones, v_refs;

  RETURN jsonb_build_object('removed', v_removed, 'phones', v_phones, 'references', v_refs);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.remove_campaign_recipients(uuid, uuid, text[], text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.remove_campaign_recipients(uuid, uuid, text[], text[], text) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('357_campaign_api_control') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
