import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
let db: PGlite;
const account='00000000-0000-0000-0000-000000000001', campaign='00000000-0000-0000-0000-000000000002', channel='00000000-0000-0000-0000-000000000003', item='00000000-0000-0000-0000-000000000004', message='00000000-0000-0000-0000-000000000005';
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA wacrm;
 CREATE TABLE wacrm.whatsapp_config(id uuid PRIMARY KEY);
 CREATE TABLE wacrm.campaigns(id uuid PRIMARY KEY,account_id uuid,status text,limite_por_hora int,batch_pause_seconds int,updated_at timestamptz);
 CREATE TABLE wacrm.disp_message_queue(id uuid PRIMARY KEY,campaign_id uuid REFERENCES wacrm.campaigns,session_id uuid,contact_id uuid,status text,scheduled_at timestamptz,updated_at timestamptz,sent_at timestamptz,waha_message_id text,tentativas int DEFAULT 0,erro_permanente boolean DEFAULT false,erro text);
 CREATE TABLE wacrm.message_logs(queue_id uuid,campaign_id uuid,contact_id uuid,session_id uuid,direcao text,mensagem text,status text,waha_message_id text);
 CREATE TABLE wacrm.campaign_metrics(campaign_id uuid PRIMARY KEY,total_enviados int DEFAULT 0,total_entregues int DEFAULT 0,total_lidos int DEFAULT 0,total_erros int DEFAULT 0);
 CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid,p_field text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('UPDATE wacrm.campaign_metrics SET %I=%I+1 WHERE campaign_id=$1',p_field,p_field) USING p_campaign_id; END $$;
 CREATE TABLE wacrm.messages(id uuid PRIMARY KEY,account_id uuid,conversation_id uuid,sender_type text);
 CREATE TABLE wacrm.flows(id uuid PRIMARY KEY,fallback_policy jsonb);
 CREATE TABLE wacrm.flow_runs(id uuid PRIMARY KEY,flow_id uuid,user_id uuid,contact_id uuid,last_advanced_at timestamptz,status text);
 CREATE TABLE wacrm.conversations(id uuid PRIMARY KEY,status text,assigned_agent_id uuid,updated_at timestamptz);
 CREATE TABLE wacrm.profiles(user_id uuid PRIMARY KEY,full_name text,email text,account_id uuid);
 CREATE TABLE wacrm.system_logs(id uuid,account_id uuid,user_id uuid,page text,action text,level text,source text,event text,message text,payload jsonb,created_at timestamptz);
 INSERT INTO wacrm.whatsapp_config VALUES('${channel}');`);
 for(const file of ['113_cron_locks.sql','118_dispatch_safety.sql','119_dispatch_status_transitions.sql','120_account_scoped_logs.sql','122_callback_outbox_ai_intents.sql','123_cron_progress.sql','124_send_idempotency.sql','125_pending_dispatch_receipts.sql','146_release_ai_reply.sql']) await db.exec(readFileSync(resolve('supabase/migrations',file),'utf8'));
},30000);
afterAll(async()=>{await db?.close()});
beforeEach(async()=>{
 await db.exec(`TRUNCATE wacrm.profiles,wacrm.system_logs,wacrm.campaigns,wacrm.disp_message_queue,wacrm.message_logs,wacrm.campaign_metrics,wacrm.campaign_callback_outbox,wacrm.send_operations,wacrm.ai_reply_intents,wacrm.messages,wacrm.dispatch_status_receipts,wacrm.cron_locks,wacrm.flows,wacrm.flow_runs CASCADE;
 INSERT INTO wacrm.campaigns VALUES('${campaign}','${account}','em_execucao',10,60,now(),NULL);
 INSERT INTO wacrm.disp_message_queue(id,campaign_id,session_id,status,scheduled_at) VALUES('${item}','${campaign}','${channel}','agendado',now());
 INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES('${campaign}');
 INSERT INTO wacrm.messages VALUES('${message}','${account}','${campaign}','customer');`);
});
it('completes once and writes a durable callback in the same transaction',async()=>{
 await db.exec(`UPDATE wacrm.disp_message_queue SET status='enviado';SELECT wacrm.complete_dispatch_campaign('${campaign}');SELECT wacrm.complete_dispatch_campaign('${campaign}');`);
 const events=await db.query<{count:number}>('SELECT count(*)::int AS count FROM wacrm.campaign_callback_outbox');expect(events.rows[0].count).toBe(1);
 const first=await db.query("SELECT * FROM wacrm.claim_campaign_callback('one')"), second=await db.query("SELECT * FROM wacrm.claim_campaign_callback('two')");expect(first.rows).toHaveLength(1);expect(second.rows).toHaveLength(0);
 await db.exec("UPDATE wacrm.campaign_callback_outbox SET lease_until=now()-interval '1 second'");expect((await db.query("SELECT * FROM wacrm.claim_campaign_callback('two')")).rows).toHaveLength(1);
});
it('reserves one AI reply per inbound intent and validates its account',async()=>{
 const claim=()=>db.query<{owned:boolean}>('SELECT wacrm.claim_ai_reply($1,$2,$3,$4) AS owned',[account,campaign,message,'node']);
 expect((await claim()).rows[0].owned).toBe(true);expect((await claim()).rows[0].owned).toBe(false);
 expect((await db.query<{owned:boolean}>('SELECT wacrm.claim_ai_reply($1,$2,$3,$4) AS owned',[channel,campaign,message,'other'])).rows[0].owned).toBe(false);
});
it('releases an AI reply reservation so a safe retry can claim it again',async()=>{
 const claim=()=>db.query<{owned:boolean}>('SELECT wacrm.claim_ai_reply($1,$2,$3,$4) AS owned',[account,campaign,message,'node']);
 const release=()=>db.query<{released:boolean}>('SELECT wacrm.release_ai_reply($1,$2,$3,$4) AS released',[account,campaign,message,'node']);
 expect((await claim()).rows[0].owned).toBe(true);expect((await claim()).rows[0].owned).toBe(false);
 expect((await release()).rows[0].released).toBe(true);
 expect((await claim()).rows[0].owned).toBe(true);
 expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege('authenticated','wacrm.release_ai_reply(uuid,uuid,uuid,text)','execute') AS allowed")).rows[0].allowed).toBe(false);
});
it('isolates ranking, actions and feedback between two accounts',async()=>{
 await db.exec(`INSERT INTO wacrm.profiles VALUES('${message}','Alice','alice@example.test','${account}'),('${item}','Bob','bob@example.test','${channel}');
 INSERT INTO wacrm.system_logs SELECT gen_random_uuid(),'${account}','${message}','/inbox','click','error',s,'test','own','{}',now() FROM unnest(ARRAY['frontend','feedback']) s;
 INSERT INTO wacrm.system_logs SELECT gen_random_uuid(),'${channel}','${item}','/inbox','click','error',s,'test','foreign','{}',now() FROM unnest(ARRAY['frontend','feedback']) s;`);
 const ranking=await db.query<{user_id:string,total_events:number}>(`SELECT * FROM wacrm.get_user_log_ranking_for_account('${account}',now()-interval '1 day')`);
 expect(ranking.rows).toHaveLength(1);expect(ranking.rows[0].user_id).toBe(message);expect(Number(ranking.rows[0].total_events)).toBe(2);
 for(const fn of ['get_action_logs_for_account','get_feedback_logs_for_account']) {
  const rows=await db.query<{message:string}>(`SELECT * FROM wacrm.${fn}('${account}',now()-interval '1 day')`);
  expect(rows.rows).toHaveLength(1);expect(rows.rows[0].message).toBe('own');
 }
});
it('reserves a send key once and isolates keys between accounts',async()=>{
 const claim=(acct:string)=>db.query<{owned:boolean}>('SELECT wacrm.reserve_send_operation($1,$2,$3) AS owned',[acct,'intent-001','hash']);
 expect((await claim(account)).rows[0].owned).toBe(true);expect((await claim(account)).rows[0].owned).toBe(false);expect((await claim(channel)).rows[0].owned).toBe(true);
});
it('stores an early receipt and applies it once after the accepted ID is recorded',async()=>{
 await db.exec("SELECT wacrm.apply_dispatch_status('wamid.test','read',NULL)");
 expect((await db.query('SELECT * FROM wacrm.dispatch_status_receipts')).rows).toHaveLength(1);
 await db.exec(`SELECT wacrm.claim_dispatch_item('${item}');SELECT wacrm.mark_queue_item_sent('${item}','${campaign}',NULL,'${channel}','hello','wamid.test',1);SELECT wacrm.replay_dispatch_receipts('wamid.test');SELECT wacrm.replay_dispatch_receipts('wamid.test');`);
 const row=(await db.query<{status:string}>('SELECT status FROM wacrm.disp_message_queue')).rows[0];expect(row.status).toBe('lido');
 expect((await db.query('SELECT * FROM wacrm.dispatch_status_receipts')).rows).toHaveLength(0);
 expect((await db.query('SELECT total_lidos,total_entregues FROM wacrm.campaign_metrics')).rows[0]).toEqual({total_lidos:1,total_entregues:1});
});
it('renews only a live lock owned by the caller',async()=>{
 await db.exec("SELECT wacrm.try_acquire_cron_lock('test','one',600)");
 expect((await db.query<{ok:boolean}>("SELECT wacrm.renew_cron_lock('test','two') AS ok")).rows[0].ok).toBe(false);
 expect((await db.query<{ok:boolean}>("SELECT wacrm.renew_cron_lock('test','one') AS ok")).rows[0].ok).toBe(true);
 await db.exec("UPDATE wacrm.cron_locks SET expires_at=now()-interval '1 second'");
 expect((await db.query<{ok:boolean}>("SELECT wacrm.renew_cron_lock('test','one') AS ok")).rows[0].ok).toBe(false);
});
it('does not let long-timeout flows hide later short-timeout flows',async()=>{
 await db.exec(`INSERT INTO wacrm.flows VALUES('${campaign}','{"on_timeout_hours":24}'),('${channel}','{"on_timeout_hours":1}');
 INSERT INTO wacrm.flow_runs VALUES('${item}','${campaign}',NULL,NULL,now()-interval '5 hours','active'),('${message}','${channel}',NULL,NULL,now()-interval '2 hours','active');`);
 expect((await db.query('SELECT id FROM wacrm.sweepable_flow_runs(1)')).rows).toEqual([{id:message}]);
});
it('browser roles cannot access coordination tables or privileged RPCs',async()=>{
 for(const fn of ['wacrm.claim_campaign_callback(text)','wacrm.claim_ai_reply(uuid,uuid,uuid,text)','wacrm.reserve_send_operation(uuid,text,text)','wacrm.replay_dispatch_receipts(text)','wacrm.renew_cron_lock(text,text)'])expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege('authenticated',$1,'execute') AS allowed",[fn])).rows[0].allowed).toBe(false);
});
