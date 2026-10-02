BEGIN;
CREATE TABLE IF NOT EXISTS wacrm.dispatch_status_receipts(message_id text NOT NULL,status text NOT NULL,error_text text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(message_id,status));
ALTER TABLE wacrm.dispatch_status_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_status_receipts FROM PUBLIC,anon,authenticated;
GRANT ALL ON wacrm.dispatch_status_receipts TO service_role;

CREATE OR REPLACE FUNCTION wacrm.apply_dispatch_status(p_message_id text, p_status text, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item wacrm.disp_message_queue%ROWTYPE; v_next text;
BEGIN
  IF p_status NOT IN ('delivered','read','failed') THEN RETURN false; END IF;
  INSERT INTO wacrm.dispatch_status_receipts(message_id,status,error_text) VALUES(p_message_id,p_status,p_error) ON CONFLICT DO NOTHING;
  SELECT * INTO v_item FROM wacrm.disp_message_queue WHERE waha_message_id = p_message_id FOR UPDATE;
  IF NOT FOUND OR v_item.status = 'enviando' THEN RETURN false; END IF;
  IF p_status = 'delivered' AND v_item.status = 'enviado' THEN v_next := 'entregue';
  ELSIF p_status = 'read' AND v_item.status IN ('enviado', 'entregue') THEN v_next := 'lido';
  ELSIF p_status = 'failed' AND v_item.status = 'enviado' THEN v_next := 'erro';
  ELSE DELETE FROM wacrm.dispatch_status_receipts WHERE message_id=p_message_id AND status=p_status; RETURN false;
  END IF;
  -- A delayed failure cannot reopen an accepted queue attempt. Until a verified
  -- asynchronous retry classifier is deployed, failed delivery requires review.
  UPDATE wacrm.disp_message_queue SET status = v_next, updated_at = clock_timestamp(),
    erro = CASE WHEN v_next = 'erro' THEN COALESCE(p_error, 'Falha de entrega; revisar antes de reenviar') ELSE erro END,
    erro_permanente = CASE WHEN v_next = 'erro' THEN true ELSE erro_permanente END
  WHERE id = v_item.id AND waha_message_id = p_message_id;
  IF v_next IN ('entregue', 'lido') AND v_item.status = 'enviado' THEN
    PERFORM wacrm.increment_campaign_metric(v_item.campaign_id, 'total_entregues');
  END IF;
  IF v_next = 'lido' THEN PERFORM wacrm.increment_campaign_metric(v_item.campaign_id, 'total_lidos'); END IF;
  IF v_next = 'erro' THEN PERFORM wacrm.increment_campaign_metric(v_item.campaign_id, 'total_erros'); END IF;
  DELETE FROM wacrm.dispatch_status_receipts WHERE message_id=p_message_id AND status=p_status;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.apply_dispatch_status(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.apply_dispatch_status(text, text, text) TO service_role;
CREATE OR REPLACE FUNCTION wacrm.replay_dispatch_receipts(p_message_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt record;
BEGIN
 FOR receipt IN SELECT * FROM wacrm.dispatch_status_receipts WHERE message_id=p_message_id
 ORDER BY CASE status WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 ELSE 3 END LOOP
 PERFORM wacrm.apply_dispatch_status(receipt.message_id,receipt.status,receipt.error_text);
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION wacrm.replay_dispatch_receipts(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.replay_dispatch_receipts(text) TO service_role;
CREATE OR REPLACE FUNCTION wacrm.reconcile_dispatch_receipts(p_limit integer DEFAULT 100)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt record;
BEGIN
 FOR receipt IN SELECT DISTINCT r.message_id FROM wacrm.dispatch_status_receipts r
 JOIN wacrm.disp_message_queue q ON q.waha_message_id=r.message_id
 WHERE q.status <> 'enviando' LIMIT least(100,greatest(1,p_limit)) LOOP
   PERFORM wacrm.replay_dispatch_receipts(receipt.message_id);
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION wacrm.reconcile_dispatch_receipts(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.reconcile_dispatch_receipts(integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
