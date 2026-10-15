import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

let db: PGlite
const A='00000000-0000-0000-0000-0000000000a1'
const B='00000000-0000-0000-0000-0000000000b1'
const CA='00000000-0000-0000-0000-0000000000a2'
const CB='00000000-0000-0000-0000-0000000000b2'
const CH='00000000-0000-0000-0000-0000000000a3'
const CBH='00000000-0000-0000-0000-0000000000b3'
const C='00000000-0000-0000-0000-0000000000a4'
const BC='00000000-0000-0000-0000-0000000000b4'
type Report={ai: Array<{sku:string,requests:number,priced_usd:number,unpriced:number}>,meta:Array<{sku:string,delivered:number,priced_brl:number,unpriced:number}>}

beforeAll(async()=>{
  db=new PGlite()
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.accounts(id uuid PRIMARY KEY);
    CREATE TABLE wacrm.contacts(id uuid PRIMARY KEY,account_id uuid,phone text);
    CREATE TABLE wacrm.whatsapp_config(id uuid PRIMARY KEY,account_id uuid,provider text);
    CREATE TABLE wacrm.conversations(id uuid PRIMARY KEY,account_id uuid,config_id uuid,contact_id uuid);
    CREATE TABLE wacrm.message_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,name text,category text,created_at timestamptz DEFAULT now());
    CREATE TABLE wacrm.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,sender_type text,status text,template_name text,message_id text,created_at timestamptz);
    CREATE TABLE wacrm.webhook_status_inbox(id bigserial PRIMARY KEY,account_id uuid,channel_id uuid,message_id text,status text,error_text text,event_ts timestamptz,UNIQUE(message_id,status));
    CREATE FUNCTION wacrm.ingest_status_events(jsonb) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
  `)
  await db.query('INSERT INTO wacrm.accounts VALUES ($1::uuid),($2::uuid)',[A,B])
  await db.query("INSERT INTO wacrm.contacts(id,account_id,phone) VALUES($1::uuid,$2::uuid,'+55 21 99999-9999')",[CA,A])
  await db.query("INSERT INTO wacrm.contacts(id,account_id,phone) VALUES($1::uuid,$2::uuid,'+55 21 99999-9999')",[CB,B])
  await db.query("INSERT INTO wacrm.whatsapp_config(id,account_id,provider) VALUES($1::uuid,$2::uuid,'meta'),($3::uuid,$4::uuid,'meta')",[CH,A,CBH,B])
  await db.query("INSERT INTO wacrm.conversations(id,account_id,config_id,contact_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid),($5::uuid,$6::uuid,$7::uuid,$8::uuid)",[C,A,CH,CA,BC,B,CBH,CB])
  await db.query("INSERT INTO wacrm.message_templates(account_id,name,category) VALUES($1::uuid,'cruzeiro','Marketing'),($2::uuid,'cruzeiro','Utility')",[A,B])
  await db.query(`INSERT INTO wacrm.messages(conversation_id,sender_type,status,template_name,message_id,created_at) VALUES
    ($1::uuid,'bot','delivered','cruzeiro','wamid.A1','2026-10-05 11:00:00+00'),
    ($1::uuid,'agent','read',NULL,'wamid.A2','2026-10-05 11:01:00+00'),
    ($2::uuid,'bot','delivered','cruzeiro','wamid.B1','2026-10-05 11:00:00+00')`,[C,BC])
  await db.exec(readFileSync(resolve('supabase/migrations/377_dashboard_costs.sql'),'utf8'))
},45_000)
afterAll(async()=>db?.close())

it('backfills only verified Meta deliveries and avoids duplicates',async()=>{
  const rows=await db.query<{account_id:string,n:number}>('SELECT account_id,count(*)::integer n FROM wacrm.meta_deliveries_cost GROUP BY 1')
  expect(Object.fromEntries(rows.rows.map(r=>[r.account_id,r.n]))).toEqual({[A]:2,[B]:1})
})

it('computes model and country/category rates per account and flags missing data',async()=>{
  await db.query(`INSERT INTO wacrm.cost_rates(account_id,source,sku,effective_from,currency,per_message,input_per_million,cached_input_per_million,output_per_million)
    VALUES($1::uuid,'meta','BR:marketing','2026-10-01','BRL',0.3217,NULL,NULL,NULL),
    ($1::uuid,'ai','openai:gpt-4.1','2026-10-01','USD',NULL,2,0.5,8)`,[A])
  await db.query(`INSERT INTO wacrm.ai_token_usage(account_id,request_id,provider,model,feature,input_tokens,output_tokens,cached_input_tokens,occurred_at)
    VALUES($1::uuid,'r1','openai','gpt-4.1','responder',1000,500,200,'2026-10-05 11:01:00+00')`,[A])
  const r=await db.query<{result:Report}>("SELECT wacrm.get_monthly_cost_report($1::uuid,'2026-10-01'::date) AS result",[A])
  expect(Number(r.rows[0].result.ai[0].priced_usd)).toBeCloseTo(0.0057)
  expect(Number(r.rows[0].result.meta.find(row=>row.sku==='BR:marketing')?.priced_brl)).toBeCloseTo(0.3217)
  expect(r.rows[0].result.meta.find(row=>row.sku==='BR:uncategorized')?.unpriced).toBe(1)
  const b=await db.query<{result:Report}>("SELECT wacrm.get_monthly_cost_report($1::uuid,'2026-10-01'::date) AS result",[B])
  expect(b.rows[0].result.ai).toEqual([])
  expect(b.rows[0].result.meta.find(x=>x.sku==='BR:utility')?.delivered).toBe(1)
})

it('stores verified webhook pricing once and honors explicit free events',async()=>{
  const events=JSON.stringify([{account_id:A,channel_id:CH,message_id:'wamid.A2',status:'read',ts:1791198000,pricing_category:'service',pricing_billable:false,country_code:'BR'}])
  const first=await db.query<{n:number}>('SELECT wacrm.ingest_status_events($1::jsonb) AS n',[events])
  const second=await db.query<{n:number}>('SELECT wacrm.ingest_status_events($1::jsonb) AS n',[events])
  expect(first.rows[0].n).toBe(1)
  expect(second.rows[0].n).toBe(0)
  const r=await db.query<{result:Report}>("SELECT wacrm.get_monthly_cost_report($1::uuid,'2026-10-01'::date) AS result",[A])
  expect(r.rows[0].result.meta.find(x=>x.sku==='BR:service')?.priced_brl).toBe(0)
  expect(r.rows[0].result.meta.find(x=>x.sku==='BR:service')?.unpriced).toBe(0)
})

it('allows only service role to read ledgers or run report RPC',async()=>{
  const r=await db.query<{anon:boolean,auth:boolean,service:boolean,ledger:boolean}>(`
    SELECT has_function_privilege('anon','wacrm.get_monthly_cost_report(uuid,date)','EXECUTE') AS anon,
     has_function_privilege('authenticated','wacrm.get_monthly_cost_report(uuid,date)','EXECUTE') AS auth,
     has_function_privilege('service_role','wacrm.get_monthly_cost_report(uuid,date)','EXECUTE') AS service,
     has_table_privilege('authenticated','wacrm.ai_token_usage','SELECT') AS ledger`)
  expect(r.rows[0]).toEqual({anon:false,auth:false,service:true,ledger:false})
})
