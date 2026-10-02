BEGIN;

CREATE OR REPLACE FUNCTION wacrm.apply_dispatch_status(p_message_id text, p_status text, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item wacrm.disp_message_queue%ROWTYPE; v_next text;
BEGIN
  SELECT * INTO v_item FROM wacrm.disp_message_queue WHERE waha_message_id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_status = 'delivered' AND v_item.status = 'enviado' THEN v_next := 'entregue';
  ELSIF p_status = 'read' AND v_item.status IN ('enviado', 'entregue') THEN v_next := 'lido';
  ELSIF p_status = 'failed' AND v_item.status = 'enviado' THEN v_next := 'erro';
  ELSE RETURN false;
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
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.apply_dispatch_status(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.apply_dispatch_status(text, text, text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
