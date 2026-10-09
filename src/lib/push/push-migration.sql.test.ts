import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 298: trigger "conversa entrou em espera" → push_outbox e reserva (claim) no máximo uma vez.
let db: PGlite
const ACC = '00000000-0000-0000-0000-0000000000a1'
const TEAM = '00000000-0000-0000-0000-0000000000e1'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
    CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, team_id uuid, status text);
    INSERT INTO wacrm.accounts VALUES ('${ACC}');
  `)
  const sql = readFileSync(resolve('supabase/migrations/298_web_push.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

const pending = async () => (await db.query<{ conversation_id: string; team_id: string | null }>('SELECT conversation_id, team_id FROM wacrm.push_outbox WHERE processed_at IS NULL')).rows

it('só a ENTRADA em pending gera aviso (insert pending ou update open→pending), com a equipe', async () => {
  await db.exec(`INSERT INTO wacrm.conversations (id, account_id, team_id, status) VALUES ('00000000-0000-0000-0000-000000000c01', '${ACC}', '${TEAM}', 'open')`)
  expect(await pending()).toHaveLength(0)
  await db.exec(`UPDATE wacrm.conversations SET status = 'pending' WHERE id = '00000000-0000-0000-0000-000000000c01'`)
  expect(await pending()).toEqual([{ conversation_id: '00000000-0000-0000-0000-000000000c01', team_id: TEAM }])
  await db.exec(`INSERT INTO wacrm.conversations (id, account_id, team_id, status) VALUES ('00000000-0000-0000-0000-000000000c02', '${ACC}', NULL, 'pending')`)
  expect(await pending()).toHaveLength(2)
})

it('já pending → pending (outro update) e vários vai-e-vem não duplicam o aviso pendente da conversa', async () => {
  await db.exec(`UPDATE wacrm.conversations SET team_id = '${TEAM}' WHERE id = '00000000-0000-0000-0000-000000000c01'`)
  await db.exec(`UPDATE wacrm.conversations SET status = 'open' WHERE id = '00000000-0000-0000-0000-000000000c01'`)
  await db.exec(`UPDATE wacrm.conversations SET status = 'pending' WHERE id = '00000000-0000-0000-0000-000000000c01'`)
  expect(await pending()).toHaveLength(2)
})

it('claim reserva uma vez só (no máximo uma entrega) e respeita o limite', async () => {
  const first = await db.query('SELECT * FROM wacrm.claim_push_outbox(1)')
  expect(first.rows).toHaveLength(1)
  const rest = await db.query('SELECT * FROM wacrm.claim_push_outbox(50)')
  expect(rest.rows).toHaveLength(1)
  expect((await db.query('SELECT * FROM wacrm.claim_push_outbox(50)')).rows).toHaveLength(0)
})

it('chave VAPID e outbox são fechadas; inscrição só é visível ao dono (RLS com policy própria)', async () => {
  const { rows } = await db.query<{ tablename: string; policies: number }>(`
    SELECT t.tablename, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='wacrm' AND p.tablename=t.tablename) AS policies
    FROM pg_tables t WHERE t.schemaname='wacrm' AND t.tablename IN ('push_vapid_keys','push_outbox','push_subscriptions') ORDER BY 1`)
  expect(rows).toEqual([
    { tablename: 'push_outbox', policies: 0 },
    { tablename: 'push_subscriptions', policies: 2 },
    { tablename: 'push_vapid_keys', policies: 0 },
  ])
})
