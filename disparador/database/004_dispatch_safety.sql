-- Public-schema legacy service, dedicated to DISPATCH_SINGLE_ACCOUNT_ID.
-- Apply only to the legacy database. Never run this against wacrm.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.disp_message_queue') IS NULL THEN
   RAISE EXCEPTION 'disp_message_queue missing: reconcile legacy schema before enabling worker';
 END IF;
END $$;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_status_check CHECK(status IN
 ('rascunho','aguardando_aprovacao','aprovada','preparando','em_execucao','pausada','encerrada','bloqueada_por_risco','erro'));
ALTER TABLE public.disp_message_queue ADD COLUMN IF NOT EXISTS message_index integer;
CREATE UNIQUE INDEX IF NOT EXISTS legacy_dispatch_intent ON public.disp_message_queue(campaign_id,contact_id,message_index);
CREATE OR REPLACE FUNCTION public.claim_legacy_dispatch_item(p_item_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE q public.disp_message_queue%ROWTYPE; c public.campaigns%ROWTYPE;
 used_count integer; in_flight integer; affected integer;
BEGIN
 SELECT * INTO q FROM public.disp_message_queue WHERE id=p_item_id;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('legacy-campaign:'||q.campaign_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('legacy-session:'||q.session_id::text,0));
 SELECT * INTO c FROM public.campaigns WHERE id=q.campaign_id FOR UPDATE;
 IF NOT FOUND OR c.status<>'em_execucao' THEN RETURN false; END IF;
 SELECT count(*) FILTER(WHERE status='enviando'),count(*) FILTER(WHERE status='enviando' OR sent_at>clock_timestamp()-interval '1 hour')
 INTO in_flight,used_count FROM public.disp_message_queue WHERE session_id=q.session_id;
 IF in_flight>=4 THEN RETURN false; END IF;
 -- Conservative shared session quota: the strictest active campaign wins.
 IF used_count >= (SELECT coalesce(min(greatest(1,limite_por_hora)),10) FROM public.campaigns
   WHERE status='em_execucao' AND (id=q.campaign_id OR session_id=q.session_id)) THEN RETURN false; END IF;
 UPDATE public.disp_message_queue SET status='enviando',updated_at=clock_timestamp()
 WHERE id=q.id AND status='agendado' AND scheduled_at<=clock_timestamp();
 GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected=1;
END; $$;
REVOKE ALL ON FUNCTION public.claim_legacy_dispatch_item(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_legacy_dispatch_item(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
