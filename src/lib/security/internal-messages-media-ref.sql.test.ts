import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 350: media_url do chat interno só aceita /api/chat-media/account-<conta da linha>/..., com a RLS REAL (SET ROLE authenticated).
let db: PGlite
const ACC = '00000000-0000-0000-0000-0000000000a1'
const OTHER_ACC = '00000000-0000-0000-0000-0000000000a2'
const ANA = '00000000-0000-0000-0000-00000000000a'
const BIA = '00000000-0000-0000-0000-00000000000b'
const asUser = async (uid: string) => {
  await db.exec(`RESET ROLE; SELECT set_config('test.uid', '${uid}', false); SET ROLE authenticated;`)
}
const ref = (acc: string, rest = 'abc-foto.png') => `/api/chat-media/account-${acc}/${rest}`
const insert = (media: string | null, acc = ACC) =>
  db.query(
    `INSERT INTO wacrm.internal_messages (account_id, sender_id, recipient_id, content, media_url, media_type) VALUES ($1, $2, $3, 'oi', $4, 'image/png')`,
    [acc, ANA, BIA, media],
  )

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
    CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
    CREATE FUNCTION wacrm.is_account_member(a uuid, min_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.members m WHERE m.account_id = a AND m.user_id = auth.uid()) $$;
    GRANT EXECUTE ON FUNCTION wacrm.is_account_member(uuid, wacrm.account_role_enum) TO authenticated;
    INSERT INTO auth.users VALUES ('${ANA}'), ('${BIA}');
    INSERT INTO wacrm.accounts VALUES ('${ACC}'), ('${OTHER_ACC}');
    INSERT INTO wacrm.members VALUES ('${ANA}', '${ACC}'), ('${BIA}', '${ACC}'), ('${ANA}', '${OTHER_ACC}');
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
    CREATE POLICY internal_messages_insert ON wacrm.internal_messages FOR INSERT
      WITH CHECK (auth.uid() = sender_id AND wacrm.is_account_member(account_id));
    CREATE POLICY internal_messages_select ON wacrm.internal_messages FOR SELECT
      USING ((auth.uid() = sender_id OR auth.uid() = recipient_id) AND wacrm.is_account_member(account_id));
    CREATE POLICY internal_messages_update ON wacrm.internal_messages FOR UPDATE
      USING (auth.uid() = recipient_id) WITH CHECK (auth.uid() = recipient_id);
    -- Linha ANTIGA (anterior à migration): URL pública do Storage. Precisa continuar marcável como lida.
    INSERT INTO wacrm.internal_messages (account_id, sender_id, recipient_id, content, media_url, media_type)
      VALUES ('${ACC}', '${ANA}', '${BIA}', 'antiga', 'https://x.supabase.co/storage/v1/object/public/chat-media/account-${ACC}/velha.png', 'image/png');
  `)
  const sql = readFileSync(resolve('supabase/migrations/350_internal_messages_media_ref.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
}, 60_000)

afterAll(async () => {
  await db?.close()
})

it('aceita a referência autenticada da PRÓPRIA conta (e mensagem sem mídia)', async () => {
  await asUser(ANA)
  await insert(ref(ACC))
  await insert(ref(ACC, 'sub/pasta/arquivo%20com%20espa%C3%A7o.pdf'))
  await insert(null)
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.internal_messages WHERE content = 'oi'`)
  expect(rows[0].n).toBe(3)
})

it('recusa URL externa, tracking, javascript:, URL pública do Storage e caminho cru', async () => {
  await asUser(ANA)
  for (const bad of [
    'https://evil.example/pixel.png',
    'http://169.254.169.254/latest/meta-data',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    `https://x.supabase.co/storage/v1/object/public/chat-media/account-${ACC}/f.png`,
    `account-${ACC}/f.png`,
    '//evil.example/x.png',
    '/api/outra-rota/x',
  ]) {
    await expect(insert(bad), bad).rejects.toThrow(/media_url do chat interno/)
  }
})

it('recusa referência de OUTRA conta (mesmo sendo membro das duas) e prefixo sem arquivo', async () => {
  await asUser(ANA)
  await expect(insert(ref(OTHER_ACC), ACC)).rejects.toThrow(/media_url do chat interno/)
  // Membro das duas contas: a referência tem que ser da conta DA LINHA.
  await expect(insert(ref(ACC), OTHER_ACC)).rejects.toThrow(/media_url do chat interno/)
  await expect(insert(`/api/chat-media/account-${ACC}/`)).rejects.toThrow(/media_url do chat interno/)
})

it('recusa travessia e disfarces no caminho: .., query, âncora, barra invertida, %2e %2f %5c, controle', async () => {
  await asUser(ANA)
  for (const rest of ['../account-outra/x.png', 'a/../b.png', 'x.png?token=1', 'x.png#frag', 'a\\b.png', '%2e%2e/x.png', 'a%2Fb.png', 'a%5cb.png', 'a\u0000b.png', 'a\nb.png']) {
    await expect(insert(ref(ACC, rest)), rest).rejects.toThrow()
  }
  await expect(insert(ref(ACC, 'x'.repeat(700)))).rejects.toThrow(/media_url do chat interno/)
})

it('UPDATE: trocar media_url por algo inválido é recusado; marcar linha ANTIGA como lida continua funcionando', async () => {
  await asUser(ANA)
  await insert(ref(ACC, 'boa.png'))
  // A RLS de UPDATE só deixa o DESTINATÁRIO atualizar: é ele quem tenta trocar a mídia por uma URL externa.
  await asUser(BIA)
  await expect(
    db.query(`UPDATE wacrm.internal_messages SET media_url = 'https://evil.example/x.png' WHERE content = 'oi'`),
  ).rejects.toThrow(/media_url do chat interno/)
  // Marcar como lida a mensagem antiga (media_url não muda) não pode falhar.
  const r = await db.query(`UPDATE wacrm.internal_messages SET read_at = now() WHERE content = 'antiga' RETURNING id`)
  expect(r.rows.length).toBe(1)
})

it('o gatilho existe e é só BEFORE INSERT/UPDATE OF media_url', async () => {
  await db.exec('RESET ROLE')
  const { rows } = await db.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'wacrm.internal_messages'::regclass AND NOT tgisinternal`,
  )
  expect(rows.map((r) => r.tgname)).toEqual(['internal_messages_media_ref'])
})
