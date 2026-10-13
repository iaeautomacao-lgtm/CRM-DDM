import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 333: contagem agrupada das 131026 pendentes por campanha, escopada pela conta e sem teto.
let db: PGlite
const A = '00000000-0000-0000-0000-0000000000a1'
const B = '00000000-0000-0000-0000-0000000000b1'
const C1 = '00000000-0000-0000-0000-00000000c001'
const C2 = '00000000-0000-0000-0000-00000000c002'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.dispatch_meta_131026_failures (
      id serial PRIMARY KEY, account_id uuid NOT NULL, telefone text NOT NULL, campaign_id uuid NOT NULL, status text NOT NULL DEFAULT 'confirmado'
    );
    INSERT INTO wacrm.dispatch_meta_131026_failures (account_id, telefone, campaign_id, status)
      SELECT '${A}', '55119' || g, '${C1}', 'pendente' FROM generate_series(1, 6000) g;           -- acima do teto antigo de 5.000
    INSERT INTO wacrm.dispatch_meta_131026_failures (account_id, telefone, campaign_id, status) VALUES
      ('${A}', 'x1', '${C2}', 'pendente'), ('${A}', 'x2', '${C2}', 'confirmado'), ('${B}', 'y1', '${C1}', 'pendente');
  `)
  const sql = readFileSync(resolve('supabase/migrations/333_dispatch_131026_pending_counts.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

it('conta só os pendentes da conta, por campanha, sem o teto de 5.000', async () => {
  const { rows } = await db.query<{ campaign_id: string; pending: string }>(`SELECT * FROM wacrm.dispatch_131026_pending_counts('${A}') ORDER BY campaign_id`)
  expect(rows.map((r) => [r.campaign_id, Number(r.pending)])).toEqual([[C1, 6000], [C2, 1]])
})

it('outra conta só vê as próprias', async () => {
  const { rows } = await db.query<{ campaign_id: string; pending: string }>(`SELECT * FROM wacrm.dispatch_131026_pending_counts('${B}')`)
  expect(rows.map((r) => [r.campaign_id, Number(r.pending)])).toEqual([[C1, 1]])
})
