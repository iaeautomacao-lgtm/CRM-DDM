import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 334: upsert do batimento (último OK só avança em sucesso; contadores; validação do nome).
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA wacrm;`)
  const sql = readFileSync(resolve('supabase/migrations/334_cron_heartbeat.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

type Row = { job: string; last_status: string; last_error: string | null; runs: string; failures: string; expected_every_seconds: number; ok_set: boolean }
const row = async (job: string) =>
  (await db.query<Row>(`SELECT job, last_status, last_error, runs::text, failures::text, expected_every_seconds, last_ok_at IS NOT NULL AS ok_set FROM wacrm.cron_heartbeat WHERE job = '${job}'`)).rows[0]
const okAt = async (job: string) => (await db.query<{ t: string }>(`SELECT last_ok_at::text AS t FROM wacrm.cron_heartbeat WHERE job = '${job}'`)).rows[0].t

it('primeira execução ok grava o último OK e a cadência', async () => {
  await db.exec(`SELECT wacrm.cron_heartbeat_record('billing', 60, 'ok', 1200, NULL)`)
  expect(await row('billing')).toMatchObject({ last_status: 'ok', last_error: null, runs: '1', failures: '0', expected_every_seconds: 60, ok_set: true })
})

it('erro NÃO apaga nem avança o último OK; conta a falha e guarda o texto curto', async () => {
  const before = await okAt('billing')
  await db.exec(`SELECT wacrm.cron_heartbeat_record('billing', 60, 'error', 50, '${'x'.repeat(900)}')`)
  const r = await row('billing')
  expect(r).toMatchObject({ last_status: 'error', runs: '2', failures: '1' })
  expect(r.last_error).toHaveLength(500)
  expect(await okAt('billing')).toBe(before)
})

it('um novo OK limpa o erro e avança o último OK', async () => {
  await db.exec(`SELECT pg_sleep(0.01); SELECT wacrm.cron_heartbeat_record('billing', 60, 'ok', 10, NULL)`)
  expect(await row('billing')).toMatchObject({ last_status: 'ok', last_error: null, runs: '3', failures: '1' })
})

it('só erros desde o começo: último OK continua nulo', async () => {
  await db.exec(`SELECT wacrm.cron_heartbeat_record('flows', 300, 'error', 0, 'HTTP 500')`)
  expect(await row('flows')).toMatchObject({ ok_set: false, last_status: 'error', failures: '1' })
})

it('nome inválido ou status desconhecido são ignorados (sem erro, sem linha)', async () => {
  await db.exec(`SELECT wacrm.cron_heartbeat_record('Nome Inválido!', 60, 'ok', 1, NULL)`)
  await db.exec(`SELECT wacrm.cron_heartbeat_record('ok_job', 60, 'talvez', 1, NULL)`)
  expect((await db.query('SELECT 1 FROM wacrm.cron_heartbeat WHERE job IN (\'Nome Inválido!\', \'ok_job\')')).rows).toHaveLength(0)
})

it('cadência fora da faixa é limitada (10 s a 7 dias)', async () => {
  await db.exec(`SELECT wacrm.cron_heartbeat_record('fast', 1, 'ok', 1, NULL); SELECT wacrm.cron_heartbeat_record('slow', 99999999, 'ok', 1, NULL)`)
  expect((await row('fast')).expected_every_seconds).toBe(10)
  expect((await row('slow')).expected_every_seconds).toBe(604800)
})
