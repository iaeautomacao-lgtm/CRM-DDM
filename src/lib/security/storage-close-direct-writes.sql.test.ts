import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Migration 351: remove as policies de escrita do navegador em chat-media/flow-media; mantém a leitura e não mexe em avatars. RLS REAL.
let db: PGlite
const USER = '00000000-0000-0000-0000-00000000000a'
const asUser = async () => {
  await db.exec(`RESET ROLE; SELECT set_config('test.uid', '${USER}', false); SET ROLE authenticated;`)
}
const policies = async () => {
  await db.exec('RESET ROLE')
  const { rows } = await db.query<{ policyname: string; cmd: string }>(
    `SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname`,
  )
  return rows
}
const insertObject = (bucket: string, name: string) =>
  db.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)`, [bucket, name])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
    CREATE SCHEMA storage;
    GRANT USAGE ON SCHEMA storage TO authenticated, service_role;
    CREATE TABLE storage.objects (bucket_id text, name text, owner uuid);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated, service_role;

    -- Policies como nas migrations 016/020/023/121 (predicados simplificados: a regra é o NOME e o COMANDO).
    CREATE POLICY "Chat media readable" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'chat-media');
    CREATE POLICY "Members can upload chat media" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'chat-media');
    CREATE POLICY "Members can update chat media" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'chat-media') WITH CHECK (bucket_id = 'chat-media');
    CREATE POLICY "Members can delete chat media" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'chat-media');
    CREATE POLICY "Flow media is publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'flow-media');
    CREATE POLICY "Members can upload flow media" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'flow-media');
    CREATE POLICY "Members can update flow media" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'flow-media') WITH CHECK (bucket_id = 'flow-media');
    CREATE POLICY "Members can delete flow media" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'flow-media');
    -- Policy de escrita com NOME DIFERENTE (produção pode divergir das migrations): a varredura precisa pegar.
    CREATE POLICY "legado: gravar anexos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'chat-media');
    -- Avatars: NÃO pode mudar.
    CREATE POLICY "Users can upload their own avatar" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars');
    CREATE POLICY "Avatars readable" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
    -- Cita chat-media E avatars: não pode ser removida (revisão manual).
    CREATE POLICY "mista: avatars e anexos" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id IN ('avatars', 'chat-media'));
    -- ALL em flow-media cobre a leitura: não pode ser removida (revisão manual).
    CREATE POLICY "tudo em flow-media" ON storage.objects FOR ALL TO authenticated USING (bucket_id = 'flow-media');
  `)
}, 60_000)

afterAll(async () => {
  await db?.close()
})

it('ANTES: o navegador logado consegue escrever direto em chat-media (o problema)', async () => {
  await asUser()
  await insertObject('chat-media', 'account-x/antes.png')
  await db.exec('RESET ROLE')
  await db.exec(`DELETE FROM storage.objects WHERE name = 'account-x/antes.png'`)
})

it('aplica (e é idempotente) e remove as policies de escrita dos dois buckets, inclusive a de nome diferente', async () => {
  const sql = readFileSync(resolve('supabase/migrations/351_storage_close_direct_writes.sql'), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
  const rows = await policies()
  const names = rows.map((r) => r.policyname)
  for (const gone of [
    'Members can upload chat media', 'Members can update chat media', 'Members can delete chat media',
    'Members can upload flow media', 'Members can update flow media', 'Members can delete flow media',
    'legado: gravar anexos',
  ]) {
    expect(names, gone).not.toContain(gone)
  }
})

it('MANTÉM a leitura, os avatars e as policies que pedem revisão manual (mista e ALL)', async () => {
  const names = (await policies()).map((r) => r.policyname)
  expect(names).toEqual(
    expect.arrayContaining([
      'Chat media readable', 'Flow media is publicly readable',
      'Users can upload their own avatar', 'Avatars readable',
      'mista: avatars e anexos', 'tudo em flow-media',
    ]),
  )
})

it('DEPOIS: a sessão do usuário não escreve mais nos dois buckets, mas ainda lê e ainda grava avatar', async () => {
  await asUser()
  await expect(insertObject('chat-media', 'account-x/depois.png')).rejects.toThrow(/row-level security/i)
  // "tudo em flow-media" (ALL, mantida para revisão) ainda permite flow-media: é o aviso da migration, fora do escopo automático.
  await insertObject('avatars', 'u/avatar.png')
  const read = await db.query(`SELECT 1 FROM storage.objects WHERE bucket_id = 'avatars'`)
  expect(read.rows.length).toBe(1)
  // A leitura de chat-media segue valendo (a rota /api/chat-media assina com a sessão).
  await db.exec('RESET ROLE')
  await db.exec(`INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-media', 'account-x/existente.png')`)
  await asUser()
  const chat = await db.query(`SELECT 1 FROM storage.objects WHERE bucket_id = 'chat-media'`)
  expect(chat.rows.length).toBe(1)
})

it('a chave de serviço (servidor) segue gravando e apagando: ignora RLS', async () => {
  await db.exec('RESET ROLE; SET ROLE service_role;')
  await insertObject('chat-media', 'account-x/servidor.png')
  const del = await db.query(`DELETE FROM storage.objects WHERE name = 'account-x/servidor.png' RETURNING name`)
  expect(del.rows.length).toBe(1)
})
