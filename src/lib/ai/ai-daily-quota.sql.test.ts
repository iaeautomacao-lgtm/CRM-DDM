import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 339: consume_ai_quota é atômica, a chamada negada não consome e o limite da conta vence o padrão.
let db: PGlite
const A = '00000000-0000-0000-0000-0000000000a1'
const B = '00000000-0000-0000-0000-0000000000b1'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
    INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
  `)
  const sql = readFileSync(resolve('supabase/migrations/339_ai_daily_quota.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

type Res = { allowed: boolean; used: number; limit: number }
const consume = async (acc: string, kind: string, def: number) =>
  (await db.query<{ r: Res }>(`SELECT wacrm.consume_ai_quota('${acc}', '${kind}', ${def}) AS r`)).rows[0].r

it('conta até o padrão e nega depois, sem consumir a chamada negada', async () => {
  expect(await consume(A, 'stt', 3)).toEqual({ allowed: true, used: 1, limit: 3 })
  expect(await consume(A, 'stt', 3)).toEqual({ allowed: true, used: 2, limit: 3 })
  expect(await consume(A, 'stt', 3)).toEqual({ allowed: true, used: 3, limit: 3 })
  expect(await consume(A, 'stt', 3)).toEqual({ allowed: false, used: 3, limit: 3 })
  expect(await consume(A, 'stt', 3)).toEqual({ allowed: false, used: 3, limit: 3 })
})

it('tipo e conta são independentes', async () => {
  expect((await consume(A, 'tag_suggest', 1)).allowed).toBe(true)
  expect((await consume(A, 'tag_suggest', 1)).allowed).toBe(false)
  expect((await consume(B, 'stt', 3)).allowed).toBe(true)
})

it('a linha da conta vence o padrão (subir libera, 0 bloqueia)', async () => {
  await db.exec(`INSERT INTO wacrm.ai_daily_quota_config (account_id, kind, daily_limit) VALUES ('${A}', 'stt', 5)`)
  expect(await consume(A, 'stt', 3)).toEqual({ allowed: true, used: 4, limit: 5 })
  await db.exec(`UPDATE wacrm.ai_daily_quota_config SET daily_limit = 0 WHERE account_id = '${A}' AND kind = 'stt'`)
  expect((await consume(A, 'stt', 3)).allowed).toBe(false)
})

it('padrão zero ou negativo bloqueia; tipo inválido e conta nula são negados', async () => {
  expect((await consume(B, 'tag_suggest', 0)).allowed).toBe(false)
  expect((await consume(B, 'tag_suggest', -5)).allowed).toBe(false)
  expect((await consume(B, 'outro', 5)).allowed).toBe(false)
  const r = await db.query<{ r: Res }>(`SELECT wacrm.consume_ai_quota(NULL, 'stt', 5) AS r`)
  expect(r.rows[0].r.allowed).toBe(false)
})

it('contagens com mais de 10 dias são limpas', async () => {
  await db.exec(`INSERT INTO wacrm.ai_daily_quota_usage (account_id, kind, day, used) VALUES ('${B}', 'stt', current_date - 30, 7)`)
  await consume(B, 'stt', 5)
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.ai_daily_quota_usage WHERE day < current_date - 11`)
  expect(r.rows[0].n).toBe(0)
})

it('tabelas e função fechadas para authenticated/anon', async () => {
  await expect(db.exec(`SET ROLE authenticated; SELECT * FROM wacrm.ai_daily_quota_usage`)).rejects.toThrow()
  await db.exec('RESET ROLE')
  await expect(db.exec(`SET ROLE anon; SELECT wacrm.consume_ai_quota('${A}', 'stt', 5)`)).rejects.toThrow()
  await db.exec('RESET ROLE')
})
