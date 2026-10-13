// Migration 306 (RLS fase 2, §8 item 3): profiles.email escondido de quem não tem members.view_emails.
// PGlite com as migrations REAIS 169/240/241/241b/276 (papéis, catálogo, has_perm) sobre um profiles com e-mail e privilégios de tabela como em produção.
// Prova: (1) o cliente do usuário NÃO lê a coluna email (nem com select *), mas lê o resto; (2) wacrm.visible_member_email devolve o e-mail só para o
// próprio, para quem tem members.view_emails NA MESMA conta e para o service role; (3) wacrm.dashboard_ai_analytics (SECURITY INVOKER, 293) continua
// funcionando para todos e só mostra o e-mail como nome de operador para quem pode ver; (4) service_role lê tudo; (5) o usuário ainda edita o próprio nome;
// (6) idempotência.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const ADMIN = '00000000-0000-0000-0000-000000000101'
const AGENT = '00000000-0000-0000-0000-000000000102'
const VIEWER = '00000000-0000-0000-0000-000000000103'
const NONAME = '00000000-0000-0000-0000-000000000104' // sem nome: o Dashboard cai no e-mail para quem pode ver
const OTHER_ADMIN = '00000000-0000-0000-0000-000000000201'

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'conta', owner_user_id uuid);
  CREATE TABLE wacrm.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE,
    account_id uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    account_role wacrm.account_role_enum NOT NULL,
    full_name text, avatar_url text, email text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now());
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  -- o dashboard_ai_analytics de hoje (293), reduzido ao trecho que lê profiles.email, SECURITY INVOKER como o original
  CREATE FUNCTION wacrm.dashboard_ai_analytics() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
  AS $$ SELECT COALESCE(jsonb_agg(jsonb_build_object('userId', p.user_id,
           'userName', COALESCE(NULLIF(p.full_name, ''), NULLIF(p.email, ''), 'Operador')) ORDER BY p.user_id), '[]'::jsonb)
         FROM wacrm.profiles p WHERE p.account_id = wacrm.current_account_id() $$;
  GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_analytics() TO authenticated, service_role;
`

let db: PGlite

async function as<T = Record<string, unknown>>(user: string | null, sql: string, role: 'authenticated' | 'service_role' = 'authenticated') {
  await db.exec(`SET ROLE ${role}; SELECT set_config('test.uid', '${user ?? ''}', false);`)
  try {
    return (await db.query<T>(sql)).rows
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('test.uid', '', false); SELECT set_config('request.jwt.claim.role', '', false);`)
  }
}

describe('migration 306 — profiles.email escondido', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(BOOTSTRAP)
    await db.exec(migration('169_profiles_lock_privileged_columns.sql'))
    for (const f of ['240_roles_foundation.sql', '241_roles_functions.sql', '241b_profiles_role_id_idx.sql', '276_billing_permissions.sql']) await db.exec(migration(f))
    await db.exec(`GRANT SELECT ON wacrm.profiles, wacrm.accounts TO authenticated; GRANT ALL ON wacrm.profiles, wacrm.accounts TO service_role;`) // produção: SELECT de tabela inteira
    await db.exec(`INSERT INTO wacrm.accounts (id) VALUES ('${A}'), ('${B}');`)
    const rows: Array<[string, string, string, string, string]> = [
      [ADMIN, A, 'admin', 'Ana Admin', 'ana@a.com'],
      [AGENT, A, 'agent', 'Bia Agente', 'bia@a.com'],
      [VIEWER, A, 'viewer', 'Vi Viewer', 'vi@a.com'],
      [NONAME, A, 'agent', '', 'sem-nome@a.com'],
      [OTHER_ADMIN, B, 'admin', 'Outra Admin', 'outra@b.com'],
    ]
    for (const [u, acc, role, name, email] of rows) {
      await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role, full_name, email) VALUES ($1, $2, $3::wacrm.account_role_enum, $4, $5)`, [u, acc, role, name, email])
    }
  }, 120_000)
  afterAll(async () => {
    await db.close()
  }, 60_000)

  it('antes da 306 o agente lê o e-mail de todos (o problema de hoje)', async () => {
    const r = await as<{ email: string }>(AGENT, `SELECT email FROM wacrm.profiles ORDER BY email`)
    expect(r.map((x) => x.email)).toContain('ana@a.com')
  })

  it('depois da 306: o cliente do usuário não lê a coluna email (nem com select *), mas lê o resto', async () => {
    await db.exec(migration('306_profiles_email_hidden.sql'))
    for (const user of [ADMIN, AGENT, VIEWER]) {
      await expect(as(user, `SELECT email FROM wacrm.profiles`)).rejects.toThrow(/permission denied/)
      await expect(as(user, `SELECT * FROM wacrm.profiles`)).rejects.toThrow(/permission denied/)
      const ok = await as<{ user_id: string; full_name: string }>(user, `SELECT user_id, full_name, account_role, avatar_url, account_id FROM wacrm.profiles ORDER BY user_id`)
      expect(ok).toHaveLength(5)
    }
  })

  it('o service role continua lendo tudo, inclusive o e-mail', async () => {
    const r = await as<{ email: string }>(null, `SELECT email FROM wacrm.profiles WHERE user_id = '${AGENT}'`, 'service_role')
    expect(r[0].email).toBe('bia@a.com')
  })

  it('visible_member_email: o próprio, quem tem members.view_emails na MESMA conta e o service role; NULL para os demais', async () => {
    const mail = async (viewer: string, target: string) =>
      (await as<{ e: string | null }>(viewer, `SELECT wacrm.visible_member_email('${target}') AS e`))[0].e
    expect(await mail(AGENT, AGENT)).toBe('bia@a.com')              // o próprio
    expect(await mail(AGENT, ADMIN)).toBeNull()                      // agente não vê os outros
    expect(await mail(VIEWER, ADMIN)).toBeNull()
    expect(await mail(ADMIN, AGENT)).toBe('bia@a.com')               // admin tem members.view_emails
    expect(await mail(ADMIN, VIEWER)).toBe('vi@a.com')
    expect(await mail(ADMIN, OTHER_ADMIN)).toBeNull()                // outra conta nunca
    expect(await mail(OTHER_ADMIN, ADMIN)).toBeNull()
    // service role (claim do PostgREST), sem usuário
    await db.exec(`SELECT set_config('request.jwt.claim.role', 'service_role', false)`)
    expect((await as<{ e: string }>(null, `SELECT wacrm.visible_member_email('${OTHER_ADMIN}') AS e`))[0].e).toBe('outra@b.com')
    await db.exec(`SELECT set_config('request.jwt.claim.role', '', false)`)
  })

  it('dashboard_ai_analytics (SECURITY INVOKER) funciona para todos; o e-mail como nome só aparece para quem pode ver', async () => {
    const names = async (user: string) => {
      const r = await as<{ j: Array<{ userId: string; userName: string }> }>(user, `SELECT wacrm.dashboard_ai_analytics() AS j`)
      return Object.fromEntries(r[0].j.map((x) => [x.userId, x.userName]))
    }
    const asAdmin = await names(ADMIN)
    expect(asAdmin[NONAME]).toBe('sem-nome@a.com')
    expect(asAdmin[AGENT]).toBe('Bia Agente')
    const asAgent = await names(AGENT)
    expect(asAgent[NONAME]).toBe('Operador')
    expect(asAgent[AGENT]).toBe('Bia Agente')
  })

  it('o usuário ainda edita o próprio nome (UPDATE por coluna da 169 intacto)', async () => {
    await as(AGENT, `UPDATE wacrm.profiles SET full_name = 'Bia Atualizada' WHERE user_id = '${AGENT}'`)
    const r = await as<{ full_name: string }>(AGENT, `SELECT full_name FROM wacrm.profiles WHERE user_id = '${AGENT}'`)
    expect(r[0].full_name).toBe('Bia Atualizada')
  })

  it('idempotente: rodar de novo não muda a função do Dashboard nem os privilégios e registra uma vez', async () => {
    const def = async () => (await db.query<{ d: string }>(`SELECT pg_get_functiondef('wacrm.dashboard_ai_analytics()'::regprocedure) AS d`)).rows[0].d
    const before = await def()
    expect((before.match(/visible_member_email/g) ?? []).length).toBe(1)
    await db.exec(migration('306_profiles_email_hidden.sql'))
    expect(await def()).toBe(before)
    await expect(as(AGENT, `SELECT email FROM wacrm.profiles`)).rejects.toThrow(/permission denied/)
    const reg = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '306_profiles_email_hidden'`)
    expect(reg.rows[0].n).toBe(1)
  })

  it('a 306 aborta sem a coluna email (nada é alterado)', async () => {
    const fresh = new PGlite()
    try {
      await fresh.exec(BOOTSTRAP.replace('full_name text, avatar_url text, email text,', 'full_name text, avatar_url text,').replace("NULLIF(p.email, '')", 'NULL'))
      await fresh.exec(migration('169_profiles_lock_privileged_columns.sql'))
      for (const f of ['240_roles_foundation.sql', '241_roles_functions.sql', '241b_profiles_role_id_idx.sql', '276_billing_permissions.sql']) await fresh.exec(migration(f))
      await expect(fresh.exec(migration('306_profiles_email_hidden.sql'))).rejects.toThrow(/não tem a coluna email/)
    } finally {
      await fresh.close()
    }
  })
})
