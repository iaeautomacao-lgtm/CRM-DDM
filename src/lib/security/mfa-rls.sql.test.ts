// Migration 310 — 2FA obrigatório no banco: policy RESTRICTIVE 'mfa_aal2_required' (USING (select wacrm.mfa_ok())) em toda
// tabela do wacrm com RLS. PGlite com auth.uid()/auth.jwt() e auth.mfa_factors simulados, e uma checagem estática que falha
// se uma migration posterior ligar RLS numa tabela do wacrm sem chamar wacrm.apply_mfa_policy.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIR = resolve(process.cwd(), 'supabase/migrations');
const M310 = readFileSync(join(DIR, '310_rls_mfa_aal2.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

const A = '00000000-0000-0000-0000-00000000000a';
const NO_FACTOR = '00000000-0000-0000-0000-000000000001';
const WITH_FACTOR = '00000000-0000-0000-0000-000000000002';
const UNVERIFIED = '00000000-0000-0000-0000-000000000003';

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA wacrm;
  GRANT USAGE ON SCHEMA auth, wacrm TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, factor_type text NOT NULL, status text NOT NULL);
  CREATE INDEX mfa_factors_user_id_idx ON auth.mfa_factors (user_id);
  INSERT INTO auth.mfa_factors (user_id, factor_type, status) VALUES
    ('${WITH_FACTOR}', 'totp', 'verified'), ('${UNVERIFIED}', 'totp', 'unverified');
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);

  -- "messages": tabela publicada no Realtime (o Realtime entrega por RLS da sessão authenticated)
  CREATE TABLE wacrm.messages (id serial PRIMARY KEY, account_id uuid NOT NULL, body text);
  ALTER TABLE wacrm.messages ENABLE ROW LEVEL SECURITY;
  CREATE POLICY messages_member ON wacrm.messages FOR ALL TO authenticated USING (true) WITH CHECK (true);
  GRANT SELECT, INSERT ON wacrm.messages TO authenticated;
  GRANT ALL ON wacrm.messages TO service_role;
  GRANT USAGE ON SEQUENCE wacrm.messages_id_seq TO authenticated;
  INSERT INTO wacrm.messages (account_id, body) VALUES ('${A}', 'oi'), ('${A}', 'tudo bem?');

  -- agregado SECURITY INVOKER (como os da 293): roda com a RLS de quem chama
  CREATE FUNCTION wacrm.dashboard_total_messages() RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path = wacrm
    AS $$ SELECT count(*) FROM wacrm.messages $$;
  GRANT EXECUTE ON FUNCTION wacrm.dashboard_total_messages() TO authenticated;

  -- webchat: leitura pelo anon (cliente público /w/[token])
  CREATE TABLE wacrm.webchat_sessions (id serial PRIMARY KEY, token text NOT NULL);
  ALTER TABLE wacrm.webchat_sessions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY webchat_public ON wacrm.webchat_sessions FOR SELECT TO anon USING (true);
  GRANT SELECT ON wacrm.webchat_sessions TO anon;
  INSERT INTO wacrm.webchat_sessions (token) VALUES ('abc');

  -- tabela sem RLS: não recebe policy
  CREATE TABLE wacrm.sem_rls (id int);
`;

describe('migration 310 — RLS exige aal2 de quem tem 2FA', { timeout: 60_000 }, () => {
  let db: PGlite;

  async function as<T>(role: 'authenticated' | 'anon' | 'service_role', user: string | null, aal: 'aal1' | 'aal2', fn: () => Promise<T>) {
    await db.query(`SELECT set_config('test.uid', $1, false), set_config('test.jwt', $2, false)`, [user ?? '', JSON.stringify({ aal })]);
    await db.exec(`SET ROLE ${role}`);
    try {
      return await fn();
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const countMessages = async () => (await db.query<{ c: number }>('SELECT count(*)::int AS c FROM wacrm.messages')).rows[0].c;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(M310);
    await db.exec(M310); // idempotente
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('sem fator: lê como antes (aal1)', async () => {
    expect(await as('authenticated', NO_FACTOR, 'aal1', countMessages)).toBe(2);
  });

  it('fator não verificado (cadastro não concluído): lê como antes', async () => {
    expect(await as('authenticated', UNVERIFIED, 'aal1', countMessages)).toBe(2);
  });

  it('fator verificado + aal1: não lê nem grava (inclusive a tabela do Realtime)', async () => {
    expect(await as('authenticated', WITH_FACTOR, 'aal1', countMessages)).toBe(0);
    await expect(
      as('authenticated', WITH_FACTOR, 'aal1', () => db.query(`INSERT INTO wacrm.messages (account_id, body) VALUES ('${A}', 'x')`)),
    ).rejects.toThrow(/row-level security/);
  });

  it('fator verificado + aal2: lê e grava normalmente', async () => {
    expect(await as('authenticated', WITH_FACTOR, 'aal2', countMessages)).toBe(2);
    await as('authenticated', WITH_FACTOR, 'aal2', () => db.query(`INSERT INTO wacrm.messages (account_id, body) VALUES ('${A}', 'ok')`));
    expect(await as('authenticated', WITH_FACTOR, 'aal2', countMessages)).toBe(3);
  });

  it('função SECURITY INVOKER (agregado da 293) também fica bloqueada em aal1', async () => {
    const run = () => db.query<{ n: number }>('SELECT wacrm.dashboard_total_messages()::int AS n').then((r) => r.rows[0].n);
    expect(await as('authenticated', WITH_FACTOR, 'aal1', run)).toBe(0);
    expect(await as('authenticated', WITH_FACTOR, 'aal2', run)).toBe(3);
  });

  it('anon do webchat e service_role não são afetados', async () => {
    const anon = await as('anon', null, 'aal1', () => db.query<{ c: number }>('SELECT count(*)::int AS c FROM wacrm.webchat_sessions'));
    expect(anon.rows[0].c).toBe(1);
    expect(await as('service_role', WITH_FACTOR, 'aal1', countMessages)).toBe(3);
  });

  it('policy em toda tabela do wacrm com RLS (e só nelas), restritiva e para authenticated', async () => {
    const rows = (
      await db.query<{ tablename: string; permissive: string; roles: string[] }>(
        `SELECT tablename, permissive, roles FROM pg_policies WHERE schemaname = 'wacrm' AND policyname = 'mfa_aal2_required' ORDER BY 1`,
      )
    ).rows;
    expect(rows.map((r) => r.tablename)).toEqual(['messages', 'webchat_sessions']);
    expect(rows.every((r) => r.permissive === 'RESTRICTIVE' && String(r.roles).includes('authenticated'))).toBe(true);
  });

  it('mfa_ok: SECURITY DEFINER, STABLE, search_path vazio, executável só por authenticated', async () => {
    const fn = (
      await db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] }>(
        `SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = 'wacrm.mfa_ok()'::regprocedure`,
      )
    ).rows[0];
    expect(fn.prosecdef).toBe(true);
    expect(fn.provolatile).toBe('s');
    expect(String(fn.proconfig)).toMatch(/search_path=("")?$/);
    const grants = (
      await db.query<{ anon: boolean; auth: boolean }>(
        `SELECT has_function_privilege('anon', 'wacrm.mfa_ok()', 'EXECUTE') AS anon, has_function_privilege('authenticated', 'wacrm.mfa_ok()', 'EXECUTE') AS auth`,
      )
    ).rows[0];
    expect(grants).toEqual({ anon: false, auth: true });
  });

  it('apply_mfa_policy: idempotente e só aceita tabela do wacrm', async () => {
    await db.exec(`CREATE TABLE wacrm.nova (id int); ALTER TABLE wacrm.nova ENABLE ROW LEVEL SECURITY;`);
    await db.exec(`SELECT wacrm.apply_mfa_policy('wacrm.nova'::regclass); SELECT wacrm.apply_mfa_policy('wacrm.nova'::regclass);`);
    const n = (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_policies WHERE tablename = 'nova' AND policyname = 'mfa_aal2_required'`)).rows[0].c;
    expect(n).toBe(1);
    await db.exec(`CREATE TABLE public.fora (id int);`);
    await expect(db.exec(`SELECT wacrm.apply_mfa_policy('public.fora'::regclass)`)).rejects.toThrow(/só tabelas do schema wacrm/);
  });

  it('registra a si mesma', async () => {
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version = '310_rls_mfa_aal2'`)).rows).toHaveLength(1);
  });
});

/** Migrations DEPOIS da 310 que ligam RLS numa tabela do wacrm precisam aplicar a policy de 2FA na mesma migration. */
export function tablesMissingMfaPolicy(files: Array<{ name: string; sql: string }>): string[] {
  const missing: string[] = [];
  for (const { name, sql } of files) {
    const num = Number.parseInt(name, 10);
    if (!Number.isFinite(num) || num <= 310) continue;
    const enabled = [...sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?wacrm\.("?)([a-z0-9_]+)\1\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map((m) => m[2]);
    for (const table of enabled) {
      const re = new RegExp(`apply_mfa_policy\\(\\s*'wacrm\\.${table}'`, 'i');
      if (!re.test(sql)) missing.push(`${name}: wacrm.${table}`);
    }
  }
  return missing;
}

describe('tabelas futuras (estático)', () => {
  it('toda migration posterior à 310 que liga RLS no wacrm chama apply_mfa_policy para a mesma tabela', () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }));
    expect(tablesMissingMfaPolicy(files)).toEqual([]);
  });

  it('o detector acusa a falta e aceita quando a chamada existe', () => {
    const sem = { name: '320_x.sql', sql: 'ALTER TABLE wacrm.novidade ENABLE ROW LEVEL SECURITY;' };
    const com = { name: '321_y.sql', sql: "ALTER TABLE wacrm.outra ENABLE ROW LEVEL SECURITY;\nSELECT wacrm.apply_mfa_policy('wacrm.outra'::regclass);" };
    const antiga = { name: '200_z.sql', sql: 'ALTER TABLE wacrm.velha ENABLE ROW LEVEL SECURITY;' };
    expect(tablesMissingMfaPolicy([sem, com, antiga])).toEqual(['320_x.sql: wacrm.novidade']);
  });
});
