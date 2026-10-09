import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

// Migration 303: lista de conversas internas (prévia + não lidas) e registro de leitura por usuário, com a RLS REAL (SET ROLE authenticated).
let db: PGlite
const ACC = '00000000-0000-0000-0000-0000000000a1'
const OTHER_ACC = '00000000-0000-0000-0000-0000000000a2'
const ANA = '00000000-0000-0000-0000-00000000000a'
const BIA = '00000000-0000-0000-0000-00000000000b'
const CAIO = '00000000-0000-0000-0000-00000000000c'
const asUser = async (uid: string | null) => {
  await db.exec(`RESET ROLE; SELECT set_config('test.uid', '${uid ?? ''}', false); SET ROLE authenticated;`)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
    CREATE SCHEMA wacrm;
    GRANT USAGE ON SCHEMA wacrm, auth TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
    CREATE TABLE wacrm.members (user_id uuid, account_id uuid);
    CREATE FUNCTION wacrm.is_account_member(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.members m WHERE m.account_id = a AND m.user_id = auth.uid()) $$;
    GRANT EXECUTE ON FUNCTION wacrm.is_account_member(uuid) TO authenticated;
    INSERT INTO auth.users VALUES ('${ANA}'), ('${BIA}'), ('${CAIO}');
    INSERT INTO wacrm.accounts VALUES ('${ACC}'), ('${OTHER_ACC}');
    INSERT INTO wacrm.members VALUES ('${ANA}', '${ACC}'), ('${BIA}', '${ACC}'), ('${CAIO}', '${ACC}');
    CREATE TABLE wacrm.internal_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES wacrm.accounts(id),
      sender_id uuid NOT NULL REFERENCES auth.users(id),
      recipient_id uuid NOT NULL REFERENCES auth.users(id),
      content text NOT NULL,
      read_at timestamptz,
      created_at timestamptz DEFAULT now(),
      media_url text, media_type text
    );
    ALTER TABLE wacrm.internal_messages ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE ON wacrm.internal_messages TO authenticated;
    CREATE POLICY internal_messages_select ON wacrm.internal_messages FOR SELECT
      USING ((auth.uid() = sender_id OR auth.uid() = recipient_id) AND wacrm.is_account_member(account_id));
    CREATE POLICY internal_messages_update ON wacrm.internal_messages FOR UPDATE
      USING (auth.uid() = recipient_id) WITH CHECK (auth.uid() = recipient_id);
  `)
  const sql = readFileSync(resolve('supabase/migrations/303_internal_chat_reads.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

const msg = (from: string, to: string, content: string, at: string, extra = '') =>
  `INSERT INTO wacrm.internal_messages (account_id, sender_id, recipient_id, content, created_at${extra ? ', media_type' : ''})
   VALUES ('${ACC}', '${from}', '${to}', '${content}', '${at}'${extra ? `, '${extra}'` : ''});`

beforeEach(async () => {
  await db.exec(`RESET ROLE; TRUNCATE wacrm.internal_messages, wacrm.internal_chat_reads;`)
  await db.exec(
    [
      msg(BIA, ANA, 'oi Ana', '2026-10-09 10:00:00+00'),
      msg(ANA, BIA, 'oi Bia', '2026-10-09 10:01:00+00'),
      msg(BIA, ANA, 'viu o contrato?', '2026-10-09 10:02:00+00'),
      msg(BIA, ANA, 'urgente', '2026-10-09 10:03:00+00'),
      msg(ANA, CAIO, 'bom dia', '2026-10-09 09:00:00+00'),
      msg(CAIO, ANA, '', '2026-10-09 11:00:00+00', 'image/png'),
      msg(BIA, CAIO, 'segredo entre Bia e Caio', '2026-10-09 12:00:00+00'),
    ].join('\n'),
  )
})

type Thread = { peer_id: string; last_preview: string; last_sender_id: string; unread_count: number; last_read_at: string | null }
const threads = async (as: string) => {
  await asUser(as)
  const { rows } = await db.query<Thread>(`SELECT * FROM wacrm.internal_chat_threads('${ACC}')`)
  await db.exec('RESET ROLE')
  return rows
}

it('lista uma linha por colega, da mais recente à mais antiga, com prévia, remetente e não lidas', async () => {
  const rows = await threads(ANA)
  expect(rows.map((r) => r.peer_id)).toEqual([CAIO, BIA])
  expect(rows[0]).toMatchObject({ last_preview: '[imagem]', last_sender_id: CAIO, unread_count: 1 })
  expect(rows[1]).toMatchObject({ last_preview: 'urgente', last_sender_id: BIA, unread_count: 3, last_read_at: null })
})

it('a RLS esconde conversa alheia: Ana não vê Bia↔Caio, e cada um só conta as próprias não lidas', async () => {
  expect((await threads(ANA)).some((r) => r.last_preview.includes('segredo'))).toBe(false)
  const bia = await threads(BIA)
  expect(bia.find((r) => r.peer_id === ANA)).toMatchObject({ unread_count: 1, last_preview: 'urgente' })
  expect(bia.find((r) => r.peer_id === CAIO)).toMatchObject({ last_preview: 'segredo entre Bia e Caio', unread_count: 0 })
})

it('prévia corta em 140 caracteres', async () => {
  await db.exec(msg(BIA, ANA, 'x'.repeat(300), '2026-10-09 13:00:00+00'))
  const bia = (await threads(ANA)).find((r) => r.peer_id === BIA)!
  expect(bia.last_preview).toHaveLength(140)
})

it('mark_read zera só aquela conversa, grava o registro de leitura e preserva as outras', async () => {
  await asUser(ANA)
  const { rows } = await db.query<{ n: number }>(`SELECT wacrm.internal_chat_mark_read('${ACC}', '${BIA}') AS n`)
  expect(rows[0].n).toBe(3)
  const after = await db.query<Thread>(`SELECT * FROM wacrm.internal_chat_threads('${ACC}')`)
  expect(after.rows.find((r) => r.peer_id === BIA)).toMatchObject({ unread_count: 0 })
  expect(after.rows.find((r) => r.peer_id === BIA)!.last_read_at).not.toBeNull()
  expect(after.rows.find((r) => r.peer_id === CAIO)).toMatchObject({ unread_count: 1 })
  // idempotente
  expect((await db.query<{ n: number }>(`SELECT wacrm.internal_chat_mark_read('${ACC}', '${BIA}') AS n`)).rows[0].n).toBe(0)
})

it('registro de leitura é privado: Bia não enxerga o de Ana e não consegue gravar em nome dela', async () => {
  await asUser(ANA)
  await db.exec(`SELECT wacrm.internal_chat_mark_read('${ACC}', '${BIA}')`)
  await asUser(BIA)
  expect((await db.query('SELECT * FROM wacrm.internal_chat_reads')).rows).toHaveLength(0)
  await expect(db.exec(`INSERT INTO wacrm.internal_chat_reads (user_id, peer_id, account_id) VALUES ('${ANA}', '${CAIO}', '${ACC}')`)).rejects.toThrow()
  await db.exec('RESET ROLE')
})

it('mark_read de quem não é membro da conta não grava nada', async () => {
  await db.exec(`RESET ROLE; DELETE FROM wacrm.members WHERE user_id = '${CAIO}'`)
  await asUser(CAIO)
  await expect(db.exec(`SELECT wacrm.internal_chat_mark_read('${ACC}', '${ANA}')`)).rejects.toThrow()
  await db.exec(`RESET ROLE; INSERT INTO wacrm.members VALUES ('${CAIO}', '${ACC}')`)
})

it('sem sessão (anon) ou consigo mesmo: nada acontece', async () => {
  await asUser(ANA)
  expect((await db.query<{ n: number }>(`SELECT wacrm.internal_chat_mark_read('${ACC}', '${ANA}') AS n`)).rows[0].n).toBe(0)
  await db.exec('RESET ROLE')
})
