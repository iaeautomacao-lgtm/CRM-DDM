import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/170_rls_tabelas_e_rpcs_definer.sql'),
  'utf8',
);
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const UA = '00000000-0000-0000-0000-0000000000a1';
const UB = '00000000-0000-0000-0000-0000000000b1';
const S1 = '00000000-0000-0000-0000-0000000000e1';
const S2 = '00000000-0000-0000-0000-0000000000e2';
let db: PGlite;

type Role = 'authenticated' | 'anon' | 'service_role';

// Simula o JWT via GUC lida por auth.uid(); RESET ROLE mesmo após erro.
async function as(role: Role, uid: string | null, sql: string) {
  await db.exec(`SET ROLE ${role}`);
  await db.exec(`SELECT set_config('test.uid', '${uid ?? ''}', false)`);
  try {
    return await db.query<Record<string, unknown>>(sql);
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('RLS e RPCs definer (migration 170)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('viewer','agent','admin','owner');
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid, account_role wacrm.account_role_enum);
      CREATE FUNCTION wacrm.is_account_member(target uuid, min_role wacrm.account_role_enum DEFAULT 'viewer')
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm AS $$
          SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid()
            AND p.account_id = target AND p.account_role >= min_role) $$;
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.system_logs (id serial PRIMARY KEY, account_id uuid, message text);
      CREATE TABLE wacrm.page_views (id serial PRIMARY KEY, account_id uuid, path text);
      CREATE TABLE wacrm.user_sessions (id uuid PRIMARY KEY, account_id uuid, page_count int DEFAULT 0, user_id uuid);
      CREATE TABLE wacrm.contact_import_variables (id serial PRIMARY KEY, contact_id uuid, value text);
      CREATE TABLE wacrm.disparador_utm_links (id serial PRIMARY KEY, campaign_id uuid, draft_id uuid, link_curto text);
      CREATE TABLE wacrm.knowledge_base_files (id serial PRIMARY KEY, account_id uuid, name text);
      CREATE TABLE wacrm.deals (id serial PRIMARY KEY, account_id uuid, stage_id uuid, status text, updated_at timestamptz);
      CREATE TABLE wacrm.deal_aging_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
        source_stage_id uuid, target_stage_id uuid, days_limit int);
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, unread_count int DEFAULT 0);
      CREATE FUNCTION wacrm.seed_tabulacao_tags(p_account_id uuid, p_user_id uuid) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
      CREATE FUNCTION wacrm.increment_unread_count(conversation_id uuid) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$ UPDATE wacrm.conversations SET unread_count = unread_count + 1 WHERE id = conversation_id $$;
      CREATE FUNCTION wacrm.increment_session_page_count(p_session_id uuid, p_user_id uuid) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$ UPDATE wacrm.user_sessions SET page_count = page_count + 1 WHERE id = p_session_id $$;
      CREATE FUNCTION wacrm.move_stale_deals(p_source_stage_id uuid, p_target_stage_id uuid, p_days_limit int) RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;
      -- GRANT da 027: tudo para anon/authenticated.
      GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO anon, authenticated, service_role;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA wacrm TO anon, authenticated, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA wacrm TO anon, authenticated, service_role;
      INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
      INSERT INTO wacrm.profiles VALUES ('${UA}', '${A}', 'viewer'), ('${UB}', '${B}', 'admin');
      INSERT INTO wacrm.contacts VALUES ('${A.replace(/a$/, '1')}', '${A}'), ('${B.replace(/b$/, '2')}', '${B}');
      INSERT INTO wacrm.system_logs (account_id, message) VALUES ('${B}', 'segredo');
      INSERT INTO wacrm.page_views (account_id, path) VALUES ('${B}', '/x');
      INSERT INTO wacrm.user_sessions (id, account_id) VALUES (gen_random_uuid(), '${B}');
      INSERT INTO wacrm.contact_import_variables (contact_id, value)
        VALUES ('${A.replace(/a$/, '1')}', 'va'), ('${B.replace(/b$/, '2')}', 'vb');
      INSERT INTO wacrm.knowledge_base_files (account_id, name) VALUES ('${A}', 'kb-a'), ('${B}', 'kb-b');
      INSERT INTO wacrm.campaigns VALUES ('${A.replace(/a$/, 'c')}', '${A}');
      INSERT INTO wacrm.disparador_utm_links (campaign_id, link_curto) VALUES ('${A.replace(/a$/, 'c')}', 'old');
      INSERT INTO wacrm.deals (account_id, stage_id, status, updated_at) VALUES
        ('${A}', '${S1}', 'open', now() - interval '30 days'),
        ('${B}', '${S1}', 'open', now() - interval '30 days');
      INSERT INTO wacrm.deal_aging_rules (account_id, source_stage_id, target_stage_id, days_limit)
        VALUES ('${A}', '${S1}', '${S2}', 7);
    `);
    await db.exec(migration);
    await db.exec(migration); // idempotente
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it.each(['system_logs', 'page_views', 'user_sessions'])(
    '%s: anon/authenticated sem acesso; service_role lê',
    async (t) => {
      await expect(as('anon', null, `SELECT * FROM wacrm.${t}`)).rejects.toThrow(/permission denied/);
      await expect(as('authenticated', UB, `SELECT * FROM wacrm.${t}`)).rejects.toThrow(/permission denied/);
      await expect(as('authenticated', UB, `DELETE FROM wacrm.${t}`)).rejects.toThrow(/permission denied/);
      expect((await as('service_role', null, `SELECT * FROM wacrm.${t}`)).rows).toHaveLength(1);
    },
  );

  it('contact_import_variables: membro lê só da própria conta e não escreve', async () => {
    const { rows } = await as('authenticated', UA, 'SELECT value FROM wacrm.contact_import_variables');
    expect(rows).toEqual([{ value: 'va' }]);
    await expect(as('authenticated', UA,
      "UPDATE wacrm.contact_import_variables SET value = 'x'")).rejects.toThrow(/permission denied/);
    await expect(as('anon', null, 'SELECT * FROM wacrm.contact_import_variables'))
      .rejects.toThrow(/permission denied/);
  });

  it('disparador_utm_links: backfill por campanha, default de conta e isolamento', async () => {
    const seen = await as('authenticated', UA, 'SELECT link_curto FROM wacrm.disparador_utm_links');
    expect(seen.rows).toEqual([{ link_curto: 'old' }]);
    // wizard: insere sem account_id (rascunho) e depois apaga por draft_id
    const draft = '00000000-0000-0000-0000-0000000000d1';
    await as('authenticated', UA,
      `INSERT INTO wacrm.disparador_utm_links (draft_id, link_curto) VALUES ('${draft}', 'novo')`);
    await as('authenticated', UA, `DELETE FROM wacrm.disparador_utm_links WHERE draft_id = '${draft}'`);
    await as('authenticated', UA,
      `INSERT INTO wacrm.disparador_utm_links (draft_id, link_curto) VALUES ('${draft}', 'novo')`);
    // outra conta não vê nem apaga
    expect((await as('authenticated', UB, 'SELECT * FROM wacrm.disparador_utm_links')).rows).toHaveLength(0);
    await as('authenticated', UB, 'DELETE FROM wacrm.disparador_utm_links');
    expect((await as('service_role', null, 'SELECT * FROM wacrm.disparador_utm_links')).rows).toHaveLength(2);
    await expect(as('anon', null, 'SELECT * FROM wacrm.disparador_utm_links')).rejects.toThrow(/permission denied/);
  });

  it('knowledge_base_files: leitura por membro, escrita exige agent', async () => {
    expect((await as('authenticated', UA, 'SELECT name FROM wacrm.knowledge_base_files')).rows)
      .toEqual([{ name: 'kb-a' }]);
    await expect(as('authenticated', UA,
      `INSERT INTO wacrm.knowledge_base_files (account_id, name) VALUES ('${A}', 'x')`))
      .rejects.toThrow(/row-level security/);
    await as('authenticated', UB,
      `INSERT INTO wacrm.knowledge_base_files (account_id, name) VALUES ('${B}', 'ok')`);
    await expect(as('authenticated', UB,
      `INSERT INTO wacrm.knowledge_base_files (account_id, name) VALUES ('${A}', 'x')`))
      .rejects.toThrow(/row-level security/);
  });

  it('run_all_deal_aging_rules: membro move só deals da própria conta; estranho é negado', async () => {
    await expect(as('authenticated', UB,
      `SELECT * FROM wacrm.run_all_deal_aging_rules('${A}')`)).rejects.toThrow(/Acesso negado/);
    await expect(as('anon', null,
      `SELECT * FROM wacrm.run_all_deal_aging_rules('${A}')`)).rejects.toThrow(/permission denied/);
    const { rows } = await as('authenticated', UA,
      `SELECT moved_count FROM wacrm.run_all_deal_aging_rules('${A}')`);
    expect(rows).toEqual([{ moved_count: 1 }]);
    const deals = await db.query<{ account_id: string; stage_id: string }>(
      'SELECT account_id, stage_id FROM wacrm.deals ORDER BY account_id');
    expect(deals.rows).toEqual([
      { account_id: A, stage_id: S2 },
      { account_id: B, stage_id: S1 }, // outra conta intacta
    ]);
  });

  it.each([
    ['move_stale_deals(gen_random_uuid(), gen_random_uuid(), 1)'],
    ['seed_tabulacao_tags(gen_random_uuid(), gen_random_uuid())'],
    ['increment_unread_count(gen_random_uuid())'],
    ['increment_session_page_count(gen_random_uuid(), gen_random_uuid())'],
  ])('%s: negada a anon/authenticated, liberada ao service_role', async (call) => {
    await expect(as('anon', null, `SELECT wacrm.${call}`)).rejects.toThrow(/permission denied/);
    await expect(as('authenticated', UA, `SELECT wacrm.${call}`)).rejects.toThrow(/permission denied/);
    await as('service_role', null, `SELECT wacrm.${call}`);
  });
});
