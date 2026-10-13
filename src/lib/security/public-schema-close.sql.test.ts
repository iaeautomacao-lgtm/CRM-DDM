// Migration 353: fecha o schema `public` legado (tabelas/views que o CRM não usa e estavam abertas ao anon no banco vivo).
// PGlite reproduzindo o achado: tabela com RLS + policy "Enable all access for all users", grants a anon/authenticated
// e view sem security_invoker. Confere o fechamento, a idempotência e o ROLLBACK executável do cabeçalho.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIR = resolve(process.cwd(), 'supabase/migrations');
const SQL = readFileSync(join(DIR, '353_close_public_schema_legacy.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

/** Bloco ROLLBACK do cabeçalho, sem o prefixo de comentário. */
function rollbackFromHeader(sql: string): string {
  const lines = sql.split('\n');
  const start = lines.findIndex((l) => /^--\s*ROLLBACK:/.test(l));
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('--') || /^--\s*={5,}/.test(l)) break;
    out.push(l.replace(/^--\s*ROLLBACK:\s*/, '').replace(/^--\s{0,13}/, ''));
  }
  return out.join('\n');
}

const SETUP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE TABLE public.calls (id serial PRIMARY KEY, note text);
  CREATE TABLE public.acordos (id serial PRIMARY KEY, cpf text);
  CREATE TABLE public.system_logs (id serial PRIMARY KEY, msg text);
  ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.acordos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Enable all access for all users" ON public.calls FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY "Enable insert access for all users" ON public.system_logs FOR INSERT WITH CHECK (true);
  CREATE POLICY "Enable read access for all users" ON public.system_logs FOR SELECT USING (true);
  CREATE VIEW public.vw_acordos_kpis AS SELECT count(*) AS n FROM public.acordos;
  INSERT INTO public.calls (note) VALUES ('ligação');
  INSERT INTO public.acordos (cpf) VALUES ('00000000000');
  GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA wacrm TO service_role;
`;

async function grantsTo(db: PGlite, role: string): Promise<string[]> {
  const r = await db.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.role_table_grants WHERE grantee = $1 AND table_schema = 'public' GROUP BY 1 ORDER BY 1`,
    [role],
  );
  return r.rows.map((x) => x.t);
}

describe('353: fecha o schema public legado', { timeout: 60_000 }, () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SETUP);
  });
  afterAll(async () => {
    await db.close();
  });

  it('antes: o anon lê e grava (o achado do banco vivo)', async () => {
    expect(await grantsTo(db, 'anon')).toEqual(['acordos', 'calls', 'system_logs', 'vw_acordos_kpis']);
    await db.exec('SET ROLE anon');
    const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.vw_acordos_kpis');
    expect(r.rows[0].n).toBe(1); // a view passa por cima da RLS de acordos
    await db.exec('RESET ROLE');
  });

  it('aplica (2x, idempotente): sem grants a anon/authenticated, sem policies "all access", view com security_invoker', async () => {
    await db.exec(SQL);
    await db.exec(SQL);
    expect(await grantsTo(db, 'anon')).toEqual([]);
    expect(await grantsTo(db, 'authenticated')).toEqual([]);
    const pol = await db.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public'`);
    expect(pol.rows).toHaveLength(0);
    const v = await db.query<{ o: string[] | null }>(`SELECT reloptions AS o FROM pg_class WHERE oid = 'public.vw_acordos_kpis'::regclass`);
    expect(v.rows[0].o).toContain('security_invoker=true');
    // os dados continuam lá (nada apagado) e o service_role lê
    await db.exec('SET ROLE service_role');
    const c = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.calls');
    expect(c.rows[0].n).toBe(1);
    await db.exec('RESET ROLE');
    await db.exec('SET ROLE anon');
    await expect(db.query('SELECT * FROM public.calls')).rejects.toThrow(/permission denied/i);
    await db.exec('RESET ROLE');
    const reg = await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '353_close_public_schema_legacy'`);
    expect(reg.rows).toHaveLength(1);
  });

  it('o ROLLBACK do cabeçalho reabre exatamente como estava', async () => {
    await db.exec(rollbackFromHeader(SQL));
    expect(await grantsTo(db, 'anon')).toEqual(['acordos', 'calls', 'system_logs', 'vw_acordos_kpis']);
    const pol = await db.query<{ p: string }>(`SELECT policyname AS p FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`);
    expect(pol.rows.map((x) => x.p)).toEqual([
      'Enable all access for all users',
      'Enable insert access for all users',
      'Enable read access for all users',
    ]);
    const reg = await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '353_close_public_schema_legacy'`);
    expect(reg.rows).toHaveLength(0);
  });
});
