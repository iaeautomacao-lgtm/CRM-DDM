// Migrations 304/305 (RLS fase 2, §8 item 4): chaves de leitura campaigns.view e pipelines.view + policies de SELECT via has_perm.
// PGlite com as migrations REAIS de papéis (169/240/241/241b/276) sobre as policies de hoje (is_account_member com os 5 ranks da 140). Prova: (1) os 5 papéis de sistema leem EXATAMENTE as mesmas linhas antes e depois; (2) quem perde a chave
// deixa de ler só aquele domínio; (3) outra conta nunca aparece; (4) idempotência; (5) a 305 aborta sem a 304 e com perfil sem role_id.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ACCOUNT_ROLES } from './roles'
import { can } from './permissions'

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const uid = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`
const TABLES = ['campaigns', 'campaign_metrics', 'disp_message_queue', 'pipelines', 'pipeline_stages', 'deals'] as const
type Counts = Record<(typeof TABLES)[number], number>

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
    full_name text, avatar_url text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now());
  -- is_account_member como a 140 o deixou: ranks owner 5 · admin 4 · supervisor 3 · agent 2 · viewer 1
  CREATE FUNCTION wacrm.is_account_member(target_account_id uuid, min_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
  AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
    AND CASE p.account_role WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'supervisor' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
      >= CASE min_role WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'supervisor' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END) $$;
  GRANT EXECUTE ON FUNCTION wacrm.is_account_member(uuid, wacrm.account_role_enum) TO authenticated, service_role;
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
`

async function bootstrap(db: PGlite) {
  await db.exec(BOOTSTRAP)
  await db.exec(migration('169_profiles_lock_privileged_columns.sql'))
  await db.exec(`GRANT SELECT ON wacrm.profiles, wacrm.accounts TO authenticated`)
  for (const f of ['240_roles_foundation.sql', '241_roles_functions.sql', '241b_profiles_role_id_idx.sql', '276_billing_permissions.sql']) await db.exec(migration(f))
}

const SCHEMA = `
  CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.campaign_metrics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.pipelines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.pipeline_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid NOT NULL REFERENCES wacrm.pipelines(id));
  CREATE TABLE wacrm.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
  -- policies de hoje (040/085/017): só membership
  ALTER TABLE wacrm.campaigns ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wacrm.campaign_metrics ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wacrm.disp_message_queue ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wacrm.pipelines ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wacrm.pipeline_stages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wacrm.deals ENABLE ROW LEVEL SECURITY;
  CREATE POLICY campaigns_select ON wacrm.campaigns FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE POLICY campaign_metrics_select ON wacrm.campaign_metrics FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE POLICY disp_message_queue_select ON wacrm.disp_message_queue FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE POLICY pipelines_select ON wacrm.pipelines FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE POLICY pipeline_stages_select ON wacrm.pipeline_stages FOR SELECT USING (
    EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id)));
  GRANT SELECT ON wacrm.campaigns, wacrm.campaign_metrics, wacrm.disp_message_queue, wacrm.pipelines, wacrm.pipeline_stages, wacrm.deals TO authenticated;
`

const ACCOUNTS_SQL = `INSERT INTO wacrm.accounts (id) VALUES ('${A}'), ('${B}');`

async function countsAs(db: PGlite, user: string): Promise<Counts> {
  await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid', '${user}', false);`)
  try {
    const out = {} as Counts
    for (const t of TABLES) out[t] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.${t}`)).rows[0].n
    return out
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('test.uid', '', false);`)
  }
}

describe('migrations 304/305 — campaigns.view e pipelines.view', { timeout: 120_000 }, () => {
  let db: PGlite
  let before: Record<string, Counts>
  const roleUser = (role: string) => uid(ACCOUNT_ROLES.indexOf(role as (typeof ACCOUNT_ROLES)[number]) + 1)
  const userB = uid(90)

  beforeAll(async () => {
    db = new PGlite()
    await bootstrap(db)
    await db.exec(SCHEMA)
    await db.exec(ACCOUNTS_SQL)
    for (const [i, role] of ACCOUNT_ROLES.entries()) {
      await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, $3::wacrm.account_role_enum)`, [uid(i + 1), A, role])
    }
    await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, 'owner')`, [userB, B])
    // dados nas duas contas
    for (const acc of [A, B]) {
      await db.exec(`
        INSERT INTO wacrm.campaigns (account_id) VALUES ('${acc}'), ('${acc}');
        INSERT INTO wacrm.campaign_metrics (account_id) VALUES ('${acc}');
        INSERT INTO wacrm.disp_message_queue (account_id) VALUES ('${acc}'), ('${acc}'), ('${acc}');
        INSERT INTO wacrm.pipelines (account_id) VALUES ('${acc}');
        INSERT INTO wacrm.deals (account_id) VALUES ('${acc}'), ('${acc}');`)
      await db.exec(`INSERT INTO wacrm.pipeline_stages (pipeline_id) SELECT id FROM wacrm.pipelines WHERE account_id = '${acc}'`)
    }
    before = {}
    for (const role of ACCOUNT_ROLES) before[role] = await countsAs(db, roleUser(role))
    await db.exec(migration('304_view_permission_keys.sql'))
    await db.exec(migration('305_campaigns_pipelines_rls_has_perm.sql'))
  }, 120_000)
  afterAll(async () => {
    await db.close()
  }, 60_000)

  it('o catálogo e os papéis de sistema batem com src/lib/auth/permissions.ts (ALL = todos os papéis)', async () => {
    for (const key of ['campaigns.view', 'pipelines.view'] as const) {
      const cat = await db.query<{ owner_only: boolean; grantable: boolean }>(`SELECT owner_only, grantable FROM wacrm.permission_catalog WHERE key = $1`, [key])
      expect(cat.rows).toEqual([{ owner_only: false, grantable: true }])
      const roles = (await db.query<{ k: string }>(
        `SELECT r.key AS k FROM wacrm.role_permissions rp JOIN wacrm.account_roles r ON r.id = rp.role_id WHERE rp.permission = $1 AND r.account_id IS NULL ORDER BY 1`, [key],
      )).rows.map((r) => r.k)
      expect(roles).toEqual(ACCOUNT_ROLES.filter((r) => can({ role: r }, key)).sort())
    }
    const deps = await db.query<{ key: string; depends_on: string[] }>(`SELECT key, depends_on FROM wacrm.permission_catalog WHERE key IN ('campaigns.manage', 'pipelines.manage') ORDER BY key`)
    expect(deps.rows).toEqual([
      { key: 'campaigns.manage', depends_on: ['channels.view', 'campaigns.view'] },
      { key: 'pipelines.manage', depends_on: ['pipelines.view'] },
    ])
  })

  it('os 5 papéis de sistema leem EXATAMENTE as mesmas linhas antes e depois (zero mudança) e nunca a outra conta', async () => {
    for (const role of ACCOUNT_ROLES) {
      const after = await countsAs(db, roleUser(role))
      expect(after, `papel ${role}`).toEqual(before[role])
      expect(after.campaigns).toBe(2)
      expect(after.deals).toBe(2)
      expect(after.disp_message_queue).toBe(3)
    }
    expect((await countsAs(db, userB)).campaigns).toBe(2) // a outra conta só vê as dela
  })

  it('quem perde campaigns.view deixa de ler SÓ campanhas/métricas/fila; quem perde pipelines.view, SÓ funis/etapas/negócios', async () => {
    const viewer = roleUser('viewer')
    await db.exec(`DELETE FROM wacrm.role_permissions WHERE permission = 'campaigns.view' AND role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL)`)
    expect(await countsAs(db, viewer)).toEqual({ campaigns: 0, campaign_metrics: 0, disp_message_queue: 0, pipelines: 1, pipeline_stages: 1, deals: 2 })
    await db.exec(`DELETE FROM wacrm.role_permissions WHERE permission = 'pipelines.view' AND role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL)`)
    expect(await countsAs(db, viewer)).toEqual({ campaigns: 0, campaign_metrics: 0, disp_message_queue: 0, pipelines: 0, pipeline_stages: 0, deals: 0 })
    // o agente não foi afetado
    expect(await countsAs(db, roleUser('agent'))).toEqual(before.agent)
    // devolve as chaves (a 304 é idempotente e repõe)
    await db.exec(migration('304_view_permission_keys.sql'))
    expect(await countsAs(db, viewer)).toEqual(before.viewer)
  })

  it('304 e 305 são idempotentes: rodar de novo não muda nada e não duplica', async () => {
    const snap = async () => ({
      cat: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.permission_catalog`)).rows[0].n,
      rp: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.role_permissions`)).rows[0].n,
      pol: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'wacrm'`)).rows[0].n,
      reg: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version LIKE '304_%' OR version LIKE '305_%'`)).rows[0].n,
    })
    const a = await snap()
    await db.exec(migration('304_view_permission_keys.sql'))
    await db.exec(migration('305_campaigns_pipelines_rls_has_perm.sql'))
    expect(await snap()).toEqual(a)
    expect(a.reg).toBe(2)
  })

  it('as 6 policies passam a usar has_perm com o termo em initplan e mantêm is_account_member', async () => {
    const r = await db.query<{ policyname: string; qual: string }>(
      `SELECT policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND policyname IN ('campaigns_select','campaign_metrics_select','disp_message_queue_select','pipelines_select','pipeline_stages_select','deals_select') ORDER BY 1`)
    expect(r.rows).toHaveLength(6)
    for (const row of r.rows) {
      expect(row.qual).toMatch(/is_account_member/)
      expect(row.qual).toMatch(/SELECT\s+(wacrm\.)?has_perm\('(campaigns|pipelines)\.view'/)
    }
  })

  it('a 305 aborta sem a 304 e com perfil sem role_id (nada é alterado)', async () => {
    const fresh = new PGlite()
    try {
      await bootstrap(fresh)
      await fresh.exec(SCHEMA)
      await fresh.exec(ACCOUNTS_SQL)
      await expect(fresh.exec(migration('305_campaigns_pipelines_rls_has_perm.sql'))).rejects.toThrow(/aplique a 304 antes/)
      await fresh.exec('ROLLBACK').catch(() => undefined)
      await fresh.exec(migration('304_view_permission_keys.sql'))
      await fresh.exec(`ALTER TABLE wacrm.profiles DISABLE TRIGGER USER`)
      await fresh.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role, role_id) VALUES ($1, $2, 'agent', NULL)`, [uid(80), A])
      await expect(fresh.exec(migration('305_campaigns_pipelines_rls_has_perm.sql'))).rejects.toThrow(/sem role_id/)
      await fresh.exec('ROLLBACK').catch(() => undefined)
      const q = await fresh.query<{ qual: string }>(`SELECT qual FROM pg_policies WHERE policyname = 'campaigns_select'`)
      expect(q.rows[0].qual).not.toMatch(/has_perm/)
    } finally {
      await fresh.close()
    }
  })
})
