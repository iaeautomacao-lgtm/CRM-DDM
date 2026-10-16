import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll,beforeAll,expect,it } from 'vitest'

let pg:PGlite
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const U='cccccccc-cccc-cccc-cccc-cccccccccccc'
const I='dddddddd-dddd-dddd-dddd-dddddddddddd'
const D='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

beforeAll(async()=>{
  pg=new PGlite()
  await pg.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE SCHEMA wacrm;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE wacrm.accounts(id uuid PRIMARY KEY);
    CREATE TABLE wacrm.whatsapp_config(id uuid PRIMARY KEY);
  `)
  await pg.query(`INSERT INTO auth.users VALUES($1::uuid)`,[U])
  await pg.query(`INSERT INTO wacrm.accounts VALUES($1::uuid),($2::uuid)`,[A,B])
  await pg.exec(readFileSync(resolve('supabase/migrations/379_meta_onboarding_foundation.sql'),'utf8'))
},45000)

afterAll(async()=>pg?.close())
it('keeps integration secrets private to backend role',async()=>{
  const res=await pg.query<{a:boolean,b:boolean,c:boolean}>(`
    SELECT has_table_privilege('anon','wacrm.meta_onboarding_integrations','SELECT') a,
      has_table_privilege('authenticated','wacrm.meta_onboarding_integrations','SELECT') b,
      has_table_privilege('service_role','wacrm.meta_onboarding_integrations','SELECT') c`)
  expect(res.rows[0]).toEqual({a:false,b:false,c:true})
})
it('enforces tenant integrity across integration/drafts/events',async()=>{
  await pg.query(`INSERT INTO wacrm.meta_onboarding_integrations
    (id,account_id,name,business_id,access_token_ciphertext,created_by)
    VALUES($1::uuid,$2::uuid,'Planejamento','111111111','encrypted-test',$3::uuid)`,[I,A,U])
  await pg.query(`INSERT INTO wacrm.meta_onboarding_drafts
    (id,account_id,integration_id,waba_id,phone_number_id,former_provider)
    VALUES($1::uuid,$2::uuid,$3::uuid,'333333333','444444444','fortics')`,[D,A,I])
  const {rows}=await pg.query<{status:string}>(`SELECT status FROM wacrm.meta_onboarding_drafts WHERE id=$1::uuid`,[D])
  expect(rows[0].status).toBe('awaiting_ownership_validation')
  await expect(pg.query(`INSERT INTO wacrm.meta_onboarding_drafts
    (account_id,integration_id,waba_id,phone_number_id,former_provider)
    VALUES($1::uuid,$2::uuid,'333333333','555555555','other')`,[B,I])).rejects.toThrow()
  await expect(pg.query(`INSERT INTO wacrm.meta_onboarding_events
    (account_id,integration_id,draft_id,action)
    VALUES($1::uuid,$2::uuid,$3::uuid,'draft_created')`,[B,I,D])).rejects.toThrow()
  const event=await pg.query<{id:number}>(`INSERT INTO wacrm.meta_onboarding_events
    (account_id,integration_id,draft_id,action)
    VALUES($1::uuid,$2::uuid,$3::uuid,'draft_created') RETURNING id`,[A,I,D])
  expect(event.rows).toHaveLength(1)
})
it('has no browser policies and does not alter legacy channels',async()=>{
  const r=await pg.query<{policies:number}>(`SELECT count(*)::integer policies FROM pg_policies
    WHERE schemaname='wacrm' AND tablename LIKE 'meta_onboarding_%'`)
  expect(r.rows[0].policies).toBe(0)
  const cols=await pg.query<{n:number}>(`SELECT count(*)::integer n FROM information_schema.columns
    WHERE table_schema='wacrm' AND table_name='whatsapp_config'`)
  expect(cols.rows[0].n).toBe(1)
})
