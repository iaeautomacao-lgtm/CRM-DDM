import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 297: tabela de jobs do export do Histórico e reserva por lease (idempotente).
let db: PGlite
const ACC = '00000000-0000-0000-0000-0000000000a1'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
    CREATE TABLE wacrm.export_history (id uuid PRIMARY KEY);
    INSERT INTO wacrm.accounts VALUES ('${ACC}');
  `)
  const sql = readFileSync(resolve('supabase/migrations/297_history_export_jobs.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql)
}, 60_000)

afterAll(async () => {
  await db?.close()
})

const insert = (extra = '') =>
  db.exec(`INSERT INTO wacrm.history_export_jobs (account_id, period_from, period_to${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ('${ACC}', '2026-10-01', '2026-10-09'${extra ? ', ' + extra.split('=')[1] : ''})`)

it('período invertido é recusado pelo CHECK', async () => {
  await expect(db.exec(`INSERT INTO wacrm.history_export_jobs (account_id, period_from, period_to) VALUES ('${ACC}', '2026-10-09', '2026-10-01')`)).rejects.toThrow()
})

it('claim reserva um job pendente, não o devolve duas vezes e retoma lease vencido', async () => {
  await insert()
  const first = await db.query<{ state: string; owner_id: string }>(`SELECT * FROM wacrm.claim_history_export_job('o1', 60)`)
  expect(first.rows).toHaveLength(1)
  expect(first.rows[0]).toMatchObject({ state: 'running', owner_id: 'o1' })
  expect((await db.query(`SELECT * FROM wacrm.claim_history_export_job('o2', 60)`)).rows).toHaveLength(0)
  await db.exec(`UPDATE wacrm.history_export_jobs SET lease_until = clock_timestamp() - interval '1 minute'`)
  const retaken = await db.query<{ owner_id: string; attempts: number }>(`SELECT * FROM wacrm.claim_history_export_job('o2', 60)`)
  expect(retaken.rows[0]).toMatchObject({ owner_id: 'o2', attempts: 1 })
})
