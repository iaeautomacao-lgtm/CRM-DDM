BEGIN;
CREATE TABLE IF NOT EXISTS wacrm.send_operations (
 account_id uuid NOT NULL,operation_key text NOT NULL,request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','completed')),
 response_body jsonb,response_status integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,operation_key)
);
ALTER TABLE wacrm.send_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.send_operations FROM PUBLIC,anon,authenticated;
GRANT ALL ON wacrm.send_operations TO service_role;
CREATE OR REPLACE FUNCTION wacrm.reserve_send_operation(p_account uuid,p_key text,p_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE inserted integer;
BEGIN
 IF length(p_key)<8 OR length(p_key)>128 THEN RAISE EXCEPTION 'Invalid operation key'; END IF;
 INSERT INTO wacrm.send_operations(account_id,operation_key,request_hash) VALUES(p_account,p_key,p_hash) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;RETURN inserted=1;
END; $$;
REVOKE ALL ON FUNCTION wacrm.reserve_send_operation(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.reserve_send_operation(uuid,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
