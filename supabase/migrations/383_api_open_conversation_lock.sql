-- ============================================================
-- 383_api_open_conversation_lock.sql   (revisão de segurança 16/10, M4 — POST /api/v1/conversations não duplica o atendimento em corrida)
--
-- PROBLEMA: a API pública busca a conversa aberta do contato no canal e, se não acha, cria. Duas chamadas simultâneas (ou o reenvio por timeout) para o mesmo
--   contato e canal acham "nada" e criam duas conversas abertas (dois conversation.opened, atribuição em dobro).
-- POR QUE NÃO UM ÍNDICE ÚNICO: a tabela tem dados antigos (podem existir duplicatas abertas, e o índice falharia) e as outras portas de entrada (webhooks
--   Meta/WAHA, webchat, motor) também criam conversa: um índice único as faria falhar em corrida em vez de abrir uma segunda. Aqui o escopo é só a API.
-- O QUE FAZ: wacrm.api_open_conversation(...) abre a conversa SERIALIZANDO por conta+contato+canal (pg_advisory_xact_lock, solto no fim da transação da
--   própria chamada): quem chega depois espera, enxerga a conversa que o primeiro acabou de criar e a devolve com created=false. Mesma regra de busca da API
--   (WhatsApp; status open/pending; WAHA por sessão, Meta por config_id) e mesmos campos do INSERT de antes. Não altera dado existente, não cria índice.
-- COMPATIBILIDADE: sem a migration a API usa o INSERT de sempre (a função inexistente é tolerada). SECURITY INVOKER, só service_role (a API usa a chave de serviço).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.conversations');                                                                                     -- não nulo
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'conversations'
--     AND column_name IN ('account_id','user_id','contact_id','status','assigned_agent_id','team_id','waha_session','config_id','channel_type');  -- 9 linhas
--   SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'api_open_conversation';  -- 0 linhas na 1ª vez
-- VERIFICAÇÃO (depois): SELECT has_function_privilege('anon', 'wacrm.api_open_conversation(uuid,uuid,uuid,text,uuid,uuid,text,uuid)', 'EXECUTE');  -- false
-- ORDEM: antes ou depois do deploy. Idempotente.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS wacrm.api_open_conversation(uuid, uuid, uuid, text, uuid, uuid, text, uuid);
--   DELETE FROM wacrm.schema_migrations WHERE version = '383_api_open_conversation_lock';
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_found integer;
BEGIN
  IF to_regclass('wacrm.conversations') IS NULL THEN
    RAISE EXCEPTION '383: falta wacrm.conversations — confira o schema vivo';
  END IF;
  SELECT count(*) INTO v_found FROM information_schema.columns
   WHERE table_schema = 'wacrm' AND table_name = 'conversations'
     AND column_name IN ('account_id', 'user_id', 'contact_id', 'status', 'assigned_agent_id', 'team_id', 'waha_session', 'config_id', 'channel_type');
  IF v_found <> 9 THEN
    RAISE EXCEPTION '383: faltam colunas em wacrm.conversations (achei % de 9) — confira o schema vivo', v_found;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.api_open_conversation(
  p_account uuid, p_user uuid, p_contact uuid, p_status text,
  p_assignee uuid, p_team uuid, p_waha_session text, p_config_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_status NOT IN ('open', 'pending') THEN
    RAISE EXCEPTION 'api_open_conversation: status inválido' USING ERRCODE = '22023';
  END IF;
  IF (p_waha_session IS NULL) = (p_config_id IS NULL) THEN
    RAISE EXCEPTION 'api_open_conversation: informe a sessão WAHA OU o canal Meta' USING ERRCODE = '22023';
  END IF;

  -- Uma chamada por vez para o mesmo contato+canal; o lock é de transação (solto ao fim desta chamada).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account::text || ':' || p_contact::text || ':' || coalesce(p_waha_session, p_config_id::text), 0));

  SELECT c.id INTO v_id
    FROM wacrm.conversations c
   WHERE c.account_id = p_account AND c.contact_id = p_contact AND c.channel_type = 'whatsapp' AND c.status IN ('open', 'pending')
     AND ((p_waha_session IS NOT NULL AND c.waha_session = p_waha_session)
          OR (p_waha_session IS NULL AND c.waha_session IS NULL AND c.config_id = p_config_id))
   ORDER BY c.created_at DESC
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('id', v_id, 'created', false);
  END IF;

  INSERT INTO wacrm.conversations (account_id, user_id, contact_id, status, assigned_agent_id, team_id, waha_session, config_id)
  VALUES (p_account, p_user, p_contact, p_status, p_assignee, p_team, p_waha_session, p_config_id)
  RETURNING id INTO v_id;
  RETURN pg_catalog.jsonb_build_object('id', v_id, 'created', true);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.api_open_conversation(uuid, uuid, uuid, text, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.api_open_conversation(uuid, uuid, uuid, text, uuid, uuid, text, uuid) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('383_api_open_conversation_lock') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
