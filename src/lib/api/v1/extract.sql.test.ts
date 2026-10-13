import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 330 (api_v1_messages / api_v1_conversation_message_counts) num Postgres real: ordem, paginação por cursor sem buracos nem
// repetição, seq estável, isolamento por conta e filtros.
let db: PGlite
const A = '00000000-0000-0000-0000-0000000000a1'
const B = '00000000-0000-0000-0000-0000000000b1'
const CV1 = '00000000-0000-0000-0000-00000000c001' // conta A, whatsapp, equipe T1
const CV2 = '00000000-0000-0000-0000-00000000c002' // conta A, webchat
const CVB = '00000000-0000-0000-0000-00000000c0b1' // conta B
const T1 = '00000000-0000-0000-0000-0000000000f1'
const CT = '00000000-0000-0000-0000-0000000000c7'

type Msg = { id: string; conversation_id: string; seq: number; created_at: string; origin: string | null; contact_id: string }
const page = async (args: Partial<{ conv: string; from: string; to: string; afterAt: string; afterId: string; channel: string; team: string; limit: number; account: string }>) =>
  (
    await db.query<Msg>(
      `SELECT * FROM wacrm.api_v1_messages($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6::uuid, $7::text, $8::uuid, $9::integer)`,
      [args.account ?? A, args.conv ?? null, args.from ?? null, args.to ?? null, args.afterAt ?? null, args.afterId ?? null, args.channel ?? null, args.team ?? null, args.limit ?? 500],
    )
  ).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid NOT NULL, contact_id uuid, channel_type text, team_id uuid);
    CREATE TABLE wacrm.messages (
      id uuid PRIMARY KEY, account_id uuid NOT NULL, conversation_id uuid NOT NULL, sender_type text NOT NULL, sender_id uuid, origin text,
      content_type text NOT NULL DEFAULT 'text', content_text text, media_url text, template_name text, status text,
      reply_to_message_id uuid, campaign_id uuid, created_at timestamptz NOT NULL
    );
    INSERT INTO wacrm.conversations VALUES
      ('${CV1}', '${A}', '${CT}', 'whatsapp', '${T1}'),
      ('${CV2}', '${A}', '${CT}', 'webchat', NULL),
      ('${CVB}', '${B}', '${CT}', 'whatsapp', NULL);
  `)
  // 5 mensagens em CV1, duas com o MESMO created_at (desempate por id); 2 em CV2; 1 em CVB (outra conta).
  const rows: string[] = []
  const add = (n: number, acc: string, conv: string, at: string, sender = 'customer') =>
    rows.push(`('00000000-0000-0000-0000-0000000a${String(n).padStart(4, '0')}', '${acc}', '${conv}', '${sender}', NULL, ${sender === 'customer' ? "'customer'" : 'NULL'}, 'text', 'm${n}', NULL, NULL, 'sent', NULL, NULL, '${at}')`)
  add(1, A, CV1, '2026-10-01 10:00:00+00')
  add(2, A, CV1, '2026-10-01 10:05:00+00', 'agent')
  add(3, A, CV1, '2026-10-01 10:05:00+00') // empata com a 2: id maior vem depois
  add(4, A, CV2, '2026-10-02 09:00:00+00')
  add(5, A, CV1, '2026-10-03 11:00:00+00', 'bot')
  add(6, A, CV2, '2026-10-04 12:00:00+00')
  add(7, B, CVB, '2026-10-01 10:00:00+00')
  await db.exec(`INSERT INTO wacrm.messages VALUES ${rows.join(',')}`)
  const sql = readFileSync(resolve('supabase/migrations/330_api_v1_conversation_extract.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

it('uma conversa: ordem (created_at, id) e seq 1..N', async () => {
  const rows = await page({ conv: CV1 })
  expect(rows.map((r) => r.id.slice(-4))).toEqual(['0001', '0002', '0003', '0005'])
  expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4])
})

it('paginação por cursor: sem buracos nem repetição e com seq contínuo, mesmo começando no meio da conversa', async () => {
  const seen: Msg[] = []
  let cursor: { at: string; id: string } | null = null
  for (let guard = 0; guard < 10; guard++) {
    const rows = await page({ conv: CV1, limit: 1, ...(cursor ? { afterAt: cursor.at, afterId: cursor.id } : {}) })
    if (rows.length === 0) break
    seen.push(rows[0])
    cursor = { at: new Date(rows[0].created_at).toISOString(), id: rows[0].id }
  }
  expect(seen.map((r) => r.id.slice(-4))).toEqual(['0001', '0002', '0003', '0005'])
  expect(seen.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4]) // a 3ª página, que começa depois do empate, continua em 3
})

it('o seq é o mesmo na lista da conversa e na extração em massa por período', async () => {
  const bulk = await page({ from: '2026-10-01', to: '2026-10-31' })
  const single = await page({ conv: CV1 })
  for (const m of single) expect(Number(bulk.find((b) => b.id === m.id)!.seq)).toBe(Number(m.seq))
  // período que começa no meio: a 5 (3ª mensagem de CV1 em ordem... posição 4) mantém seq 4
  const mid = await page({ from: '2026-10-03', to: '2026-10-05' })
  expect(mid.map((r) => [r.id.slice(-4), Number(r.seq)])).toEqual([['0005', 4], ['0006', 2]])
})

it('extração por período é ordenada entre conversas e respeita from (inclusivo) e to (exclusivo)', async () => {
  const rows = await page({ from: '2026-10-01', to: '2026-10-03' })
  expect(rows.map((r) => r.id.slice(-4))).toEqual(['0001', '0002', '0003', '0004'])
})

it('NUNCA devolve mensagem de outra conta (nem pedindo o id da conversa dela)', async () => {
  expect((await page({ from: '2026-10-01', to: '2026-10-31' })).some((r) => r.id.endsWith('0007'))).toBe(false)
  expect(await page({ conv: CVB })).toHaveLength(0)
  expect((await page({ account: B, from: '2026-10-01', to: '2026-10-31' })).map((r) => r.id.slice(-4))).toEqual(['0007'])
})

it('filtros de canal (incluindo padrão whatsapp) e equipe', async () => {
  expect((await page({ channel: 'webchat' })).map((r) => r.id.slice(-4))).toEqual(['0004', '0006'])
  expect((await page({ channel: 'whatsapp' })).map((r) => r.id.slice(-4))).toEqual(['0001', '0002', '0003', '0005'])
  expect((await page({ team: T1 })).map((r) => r.id.slice(-4))).toEqual(['0001', '0002', '0003', '0005'])
})

it('limite é aplicado (teto 1000) e message_count agrega várias conversas numa chamada', async () => {
  expect(await page({ limit: 2 })).toHaveLength(2)
  const counts = await db.query<{ conversation_id: string; message_count: string }>(
    `SELECT * FROM wacrm.api_v1_conversation_message_counts($1::uuid, ARRAY[$2::uuid, $3::uuid, $4::uuid])`,
    [A, CV1, CV2, CVB],
  )
  const byConv = Object.fromEntries(counts.rows.map((r) => [r.conversation_id, Number(r.message_count)]))
  expect(byConv).toEqual({ [CV1]: 4, [CV2]: 2 }) // a conversa da outra conta não conta
})
