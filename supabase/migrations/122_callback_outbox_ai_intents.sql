BEGIN;
CREATE TABLE IF NOT EXISTS wacrm.campaign_callback_outbox (
  campaign_id uuid PRIMARY KEY REFERENCES wacrm.campaigns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','delivered')),
  owner_id text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz
);
ALTER TABLE wacrm.campaign_callback_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.campaign_callback_outbox FROM PUBLIC,anon,authenticated;
GRANT ALL ON wacrm.campaign_callback_outbox TO service_role;
CREATE OR REPLACE FUNCTION wacrm.complete_dispatch_campaign(p_campaign_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text; v_account uuid;
BEGIN
  SELECT status,account_id INTO v_status,v_account FROM wacrm.campaigns WHERE id=p_campaign_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'em_execucao' THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM wacrm.disp_message_queue WHERE campaign_id=p_campaign_id) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM wacrm.disp_message_queue WHERE campaign_id=p_campaign_id
    AND (status IN ('agendado','enviando','pausado') OR (status='erro' AND erro_permanente=false AND tentativas<5))) THEN RETURN false; END IF;
  UPDATE wacrm.campaigns SET status='encerrada',updated_at=clock_timestamp() WHERE id=p_campaign_id;
  INSERT INTO wacrm.campaign_callback_outbox(campaign_id,account_id) VALUES(p_campaign_id,v_account) ON CONFLICT DO NOTHING;
  RETURN true;
END; $$;
CREATE OR REPLACE FUNCTION wacrm.claim_campaign_callback(p_owner text)
RETURNS SETOF wacrm.campaign_callback_outbox LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE wacrm.campaign_callback_outbox SET state='sending',owner_id=p_owner,lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1
  WHERE campaign_id=(SELECT campaign_id FROM wacrm.campaign_callback_outbox WHERE
    (state='pending' AND next_attempt_at<=clock_timestamp()) OR (state='sending' AND lease_until<clock_timestamp())
    ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *;
$$;
CREATE TABLE IF NOT EXISTS wacrm.ai_reply_intents (
 account_id uuid NOT NULL,conversation_id uuid NOT NULL,inbound_message_id uuid NOT NULL,
 node_key text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,conversation_id,inbound_message_id,node_key)
);
ALTER TABLE wacrm.ai_reply_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.ai_reply_intents FROM PUBLIC,anon,authenticated;
GRANT ALL ON wacrm.ai_reply_intents TO service_role;
CREATE OR REPLACE FUNCTION wacrm.claim_ai_reply(p_account uuid,p_conversation uuid,p_message uuid,p_node text DEFAULT '')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE inserted integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM wacrm.messages WHERE id=p_message AND conversation_id=p_conversation AND account_id=p_account AND sender_type='customer') THEN RETURN false; END IF;
 INSERT INTO wacrm.ai_reply_intents(account_id,conversation_id,inbound_message_id,node_key) VALUES(p_account,p_conversation,p_message,COALESCE(p_node,'')) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;RETURN inserted=1;
END; $$;
REVOKE ALL ON FUNCTION wacrm.complete_dispatch_campaign(uuid), wacrm.claim_campaign_callback(text),wacrm.claim_ai_reply(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.complete_dispatch_campaign(uuid), wacrm.claim_campaign_callback(text),wacrm.claim_ai_reply(uuid,uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
