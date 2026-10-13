import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 332: coluna sem default, trigger que reseta o marcador SÓ no claim e semântica do compare-and-set num Postgres real.
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.disp_message_queue (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'agendado', note text);
    INSERT INTO wacrm.disp_message_queue (status) VALUES ('agendado'), ('agendado');
  `)
  const sql = readFileSync(resolve('supabase/migrations/332_dispatch_provider_call_marker.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

const marker = async (id: number) =>
  (await db.query<{ m: string | null }>(`SELECT provider_call_started_at::text AS m FROM wacrm.disp_message_queue WHERE id = ${id}`)).rows[0].m

it('a coluna é nullable e sem default (ADD COLUMN instantâneo, sem reescrever a tabela)', async () => {
  const { rows } = await db.query<{ is_nullable: string; column_default: string | null }>(
    `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='disp_message_queue' AND column_name='provider_call_started_at'`)
  expect(rows).toEqual([{ is_nullable: 'YES', column_default: null }])
  expect(await marker(1)).toBeNull() // linhas antigas seguem NULL
})

it("o claim (status → 'enviando') grava '-infinity'; outros updates não mexem no marcador", async () => {
  await db.exec(`UPDATE wacrm.disp_message_queue SET note = 'x' WHERE id = 1`)
  expect(await marker(1)).toBeNull()
  await db.exec(`UPDATE wacrm.disp_message_queue SET status = 'enviando' WHERE id = 1`)
  expect(await marker(1)).toBe('-infinity')
  // 'enviando' → 'enviando' (renovar lease etc.) não é um claim: o marcador gravado pelo app fica
  await db.exec(`UPDATE wacrm.disp_message_queue SET provider_call_started_at = '2026-10-09 12:00:00+00' WHERE id = 1`)
  await db.exec(`UPDATE wacrm.disp_message_queue SET status = 'enviando', note = 'lease' WHERE id = 1`)
  const same = await db.query<{ ok: boolean }>("SELECT provider_call_started_at = '2026-10-09 12:00:00+00'::timestamptz AS ok FROM wacrm.disp_message_queue WHERE id = 1")
  expect(same.rows[0].ok).toBe(true)
})

it('depois de voltar à fila e ser reivindicado de novo, o marcador antigo NÃO vaza para a nova tentativa', async () => {
  await db.exec(`UPDATE wacrm.disp_message_queue SET status = 'agendado' WHERE id = 1`)
  await db.exec(`UPDATE wacrm.disp_message_queue SET status = 'enviando' WHERE id = 1`)
  expect(await marker(1)).toBe('-infinity')
})

it('compare-and-set: só o primeiro remetente passa de -infinity para um timestamp', async () => {
  await db.exec(`UPDATE wacrm.disp_message_queue SET status = 'enviando' WHERE id = 2`)
  const cas = () =>
    db.query<{ id: number }>(
      `UPDATE wacrm.disp_message_queue SET provider_call_started_at = now()
        WHERE id = 2 AND status = 'enviando' AND (provider_call_started_at IS NULL OR provider_call_started_at = '-infinity') RETURNING id`)
  expect((await cas()).rows).toHaveLength(1)
  expect((await cas()).rows).toHaveLength(0) // o segundo remetente perde: não chama o provedor
})
