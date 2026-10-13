// Migrations 318/319 (TASK5 — cargos e permissões). PGlite com as migrations REAIS 169, 240, 241, 241b, 276, 304, 312, 313,
// 318 e 319. Prova: admin cria e gere personalizados; proprietário e admin ajustam cargos de sistema ABAIXO deles, por
// organização, com restaurar padrão; sem escalada; nunca o próprio cargo nem do mesmo nível; has_perm e o account_role
// (compat) acompanham o ajuste sem tirar ninguém do cargo; convite guarda o cargo e o aplica no aceite; auditoria.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { SYSTEM_ROLE_PERMISSIONS, validateCustomRolePermissions } from '@/lib/auth/permissions'

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const OWNER = '00000000-0000-0000-0000-000000000101'
const ADMIN = '00000000-0000-0000-0000-000000000102'
const ADMIN2 = '00000000-0000-0000-0000-000000000105'
const SUP = '00000000-0000-0000-0000-000000000106'
const AGENT = '00000000-0000-0000-0000-000000000103'
const NEWBIE = '00000000-0000-0000-0000-000000000107'
const OWNER_B = '00000000-0000-0000-0000-000000000201'

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL DEFAULT 'conta', owner_user_id uuid);
  CREATE TABLE wacrm.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
    account_id uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE, account_role wacrm.account_role_enum NOT NULL,
    full_name text, avatar_url text, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE TABLE wacrm.account_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE, role wacrm.account_role_enum NOT NULL CHECK (role <> 'owner'),
    created_by_user_id uuid, label text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    accepted_at timestamptz, accepted_by_user_id uuid
  );
  -- auditoria (131): só registra o que chega
  CREATE TABLE wacrm.audit_test (account_id uuid, action text, resource_id uuid, summary text, changes jsonb, metadata jsonb);
  CREATE FUNCTION wacrm.audit_write(p_account uuid, p_event text, p_resource_type text, p_resource_id uuid, p_label text,
    p_action text, p_summary text, p_changes jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS void
    LANGUAGE sql AS $$ INSERT INTO wacrm.audit_test VALUES (p_account, p_action, p_resource_id, p_summary, p_changes, p_metadata) $$;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`

type Json = Record<string, unknown>
let db: PGlite

async function svc<T = Json>(sql: string, params: unknown[] = []): Promise<T> {
  await db.exec('SET ROLE service_role')
  try {
    return (await db.query<{ r: T }>(sql, params)).rows[0].r
  } finally {
    await db.exec('RESET ROLE')
  }
}
const sysRole = async (key: string) =>
  (await db.query<{ id: string }>(`SELECT id FROM wacrm.account_roles WHERE account_id IS NULL AND key = $1`, [key])).rows[0].id
const setSystem = async (actor: string, key: string, perms: string[], account = A) =>
  svc(`SELECT wacrm.set_system_role_permissions($1, $2, $3, $4::text[]) AS r`, [account, actor, await sysRole(key), perms])
const resetSystem = async (actor: string, key: string, account = A) =>
  svc(`SELECT wacrm.reset_system_role_permissions($1, $2, $3) AS r`, [account, actor, await sysRole(key)])
const createCustom = (actor: string, name: string, perms: string[], account = A) =>
  svc(`SELECT wacrm.create_custom_role($1, $2, $3, NULL, $4::text[]) AS r`, [account, actor, name, perms])
const assign = (actor: string, target: string, role: string, account = A) =>
  svc(`SELECT wacrm.assign_member_role($1, $2, $3, $4) AS r`, [account, actor, target, role])
const hasPerm = async (user: string, perm: string) => {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [user])
  return (await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm($1) AS ok`, [perm])).rows[0].ok
}
const profile = async (user: string) =>
  (await db.query<{ account_role: string; key: string }>(
    `SELECT p.account_role::text, r.key FROM wacrm.profiles p JOIN wacrm.account_roles r ON r.id = p.role_id WHERE p.user_id = $1`,
    [user],
  )).rows[0]
const detail = (e: unknown) => JSON.parse((e as { detail: string }).detail)
const fail = async (p: Promise<unknown>) => (await p.then(() => { throw new Error('esperava erro') }, (e: unknown) => e)) as { code: string; detail: string; message: string }

const SUP_DEFAULT = [...SYSTEM_ROLE_PERMISSIONS.supervisor]

describe('migrations 318/319 — cargos por nível e por organização', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(BOOTSTRAP)
    await db.exec(migration('169_profiles_lock_privileged_columns.sql'))
    for (const f of ['240_roles_foundation.sql', '241_roles_functions.sql', '241b_profiles_role_id_idx.sql', '276_billing_permissions.sql',
      '304_view_permission_keys.sql', '312_custom_role_validation.sql', '313_custom_roles.sql', '318_roles_by_level.sql', '319_invitation_role_id.sql']) {
      await db.exec(migration(f))
    }
    await db.exec(migration('318_roles_by_level.sql')) // idempotentes
    await db.exec(migration('319_invitation_role_id.sql'))
  }, 120_000)
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await db.exec(`RESET ROLE; DELETE FROM wacrm.account_invitations; DELETE FROM wacrm.account_role_overrides; DELETE FROM wacrm.profiles;
      DELETE FROM wacrm.account_roles WHERE account_id IS NOT NULL; DELETE FROM wacrm.audit_test;`)
    await db.exec(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES
      ('${OWNER}', '${A}', 'owner'), ('${ADMIN}', '${A}', 'admin'), ('${ADMIN2}', '${A}', 'admin'), ('${SUP}', '${A}', 'supervisor'),
      ('${AGENT}', '${A}', 'agent'), ('${NEWBIE}', '${B}', 'owner'), ('${OWNER_B}', '${B}', 'owner')`)
  })

  it('roles.manage: admin e acima, não ownerOnly e não concedível', async () => {
    const c = (await db.query<Json>(`SELECT owner_only, grantable FROM wacrm.permission_catalog WHERE key = 'roles.manage'`)).rows[0]
    expect(c).toEqual({ owner_only: false, grantable: false })
    expect(await hasPerm(ADMIN, 'roles.manage')).toBe(true)
    expect(await hasPerm(SUP, 'roles.manage')).toBe(false)
  })

  it('validação banco = TS depois da 318 (roles.manage não concedível; ownerOnly)', async () => {
    const norm = (e: object) => JSON.stringify(e, Object.keys(e).sort())
    for (const perms of [['roles.manage'], ['members.reset_password', 'inbox.view'], [...SYSTEM_ROLE_PERMISSIONS.admin]]) {
      const db1 = (await svc<Json[]>(`SELECT wacrm.custom_role_permission_errors($1::text[]) AS r`, [perms])).map(norm).sort()
      expect(db1, perms.join()).toEqual(validateCustomRolePermissions(perms).map(norm).sort())
    }
  })

  describe('personalizado pelo admin', () => {
    it('admin cria; operador/supervisor não (forbidden); ownerOnly e roles.manage nunca entram', async () => {
      expect(await createCustom(ADMIN, 'Cobrança', ['inbox.view', 'inbox.reply'])).toMatchObject({ compat_role: 'agent' })
      expect(detail(await fail(createCustom(SUP, 'X', ['inbox.view'])))).toEqual({ code: 'forbidden' })
      expect((await fail(createCustom(ADMIN, 'Y', ['ownership.transfer']))).code).toBe('22023')
      expect((await fail(createCustom(ADMIN, 'Y', ['roles.manage']))).code).toBe('22023')
    })

    it('sem escalada: admin sem uma permissão (ajustada pelo proprietário) não a concede', async () => {
      const adminDefault = [...SYSTEM_ROLE_PERMISSIONS.admin].filter((p) => !['roles.manage', 'integrations.manage', 'campaigns.rate_limit', 'campaigns.manage'].includes(p))
      await setSystem(OWNER, 'admin', adminDefault)
      expect(await hasPerm(ADMIN, 'campaigns.manage')).toBe(false)
      expect(await hasPerm(ADMIN, 'roles.manage')).toBe(true) // não concedível: fica do padrão
      const e = await fail(createCustom(ADMIN, 'Disparo', ['channels.view', 'campaigns.view', 'campaigns.manage']))
      expect(e.code).toBe('42501')
      expect(detail(e)).toEqual({ code: 'escalation', permissions: ['campaigns.manage'] })
      // o proprietário pode
      expect(await createCustom(OWNER, 'Disparo', ['channels.view', 'campaigns.view', 'campaigns.manage'])).toMatchObject({ compat_role: 'admin' })
    })

    it('admin edita e apaga personalizado (inclusive de compat admin, que fica abaixo dele)', async () => {
      const r = (await createCustom(OWNER, 'Quase admin', ['channels.view', 'campaigns.view', 'campaigns.manage'])) as { id: string }
      const upd = await svc(`SELECT wacrm.update_custom_role($1, $2, $3, 'Renomeado', NULL, NULL) AS r`, [A, ADMIN, r.id])
      expect(upd).toMatchObject({ id: r.id })
      expect(await svc(`SELECT wacrm.delete_custom_role($1, $2, $3) AS r`, [A, ADMIN, r.id])).toMatchObject({ name: 'Renomeado' })
    })
  })

  describe('ajuste de cargo de sistema por organização', () => {
    it('admin ajusta supervisor: has_perm e compat acompanham, o membro continua no cargo; outra organização não muda', async () => {
      const sem = SUP_DEFAULT.filter((p) => p !== 'reports.export')
      const r = await setSystem(ADMIN, 'supervisor', sem)
      expect(r).toMatchObject({ customized: true, compat_role: 'supervisor' })
      expect(await hasPerm(SUP, 'reports.export')).toBe(false)
      expect(await hasPerm(SUP, 'reports.view_team')).toBe(true)
      // mais que o padrão (campaigns.manage + dependências): compat sobe para admin, cargo continua supervisor
      const mais = await setSystem(ADMIN, 'supervisor', [...SUP_DEFAULT, 'campaigns.view', 'campaigns.manage'])
      expect(mais).toMatchObject({ compat_role: 'admin', previous_compat_role: 'supervisor', members_updated: 1 })
      expect(await profile(SUP)).toEqual({ account_role: 'admin', key: 'supervisor' })
      expect(await hasPerm(SUP, 'campaigns.manage')).toBe(true)
      // outra organização: padrão
      await db.exec(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ('00000000-0000-0000-0000-000000000299', '${B}', 'supervisor')`)
      expect(await hasPerm('00000000-0000-0000-0000-000000000299', 'campaigns.manage')).toBe(false)
    })

    it('restaurar padrão volta o conjunto e o compat', async () => {
      await setSystem(ADMIN, 'supervisor', [...SUP_DEFAULT, 'campaigns.view', 'campaigns.manage'])
      expect(await resetSystem(ADMIN, 'supervisor')).toMatchObject({ customized: false, compat_role: 'supervisor', members_updated: 1 })
      expect(await profile(SUP)).toEqual({ account_role: 'supervisor', key: 'supervisor' })
      expect(await hasPerm(SUP, 'campaigns.manage')).toBe(false)
      expect((await db.query(`SELECT 1 FROM wacrm.account_role_overrides`)).rows).toHaveLength(0)
    })

    it('nível: admin não mexe no admin (o próprio) nem no proprietário; proprietário mexe no admin; supervisor não gere', async () => {
      expect(detail(await fail(setSystem(ADMIN, 'admin', [...SYSTEM_ROLE_PERMISSIONS.admin].filter((p) => p !== 'roles.manage'))))).toEqual({ code: 'role_level' })
      expect(detail(await fail(setSystem(OWNER, 'owner', ['inbox.view'])))).toEqual({ code: 'role_level' })
      expect(await setSystem(OWNER, 'admin', [...SYSTEM_ROLE_PERMISSIONS.admin].filter((p) => !['roles.manage', 'integrations.manage'].includes(p)))).toMatchObject({ customized: true })
      expect(detail(await fail(setSystem(SUP, 'agent', ['inbox.view'])))).toEqual({ code: 'forbidden' })
    })

    it('sem escalada e validação: chave desconhecida/ownerOnly/não concedível/dependência → 22023', async () => {
      for (const bad of [['x.y'], ['account.delete'], ['roles.manage'], ['inbox.reply']]) {
        expect((await fail(setSystem(ADMIN, 'agent', bad))).code, bad.join()).toBe('22023')
      }
    })

    it('escrita legada de account_role num cargo ajustado: role_id = o cargo e account_role = o compat efetivo', async () => {
      await setSystem(ADMIN, 'supervisor', [...SUP_DEFAULT, 'campaigns.view', 'campaigns.manage'])
      await db.query(`UPDATE wacrm.profiles SET account_role = 'supervisor' WHERE user_id = $1`, [AGENT])
      expect(await profile(AGENT)).toEqual({ account_role: 'admin', key: 'supervisor' })
    })

    it('auditoria: ajuste e restauração com antes/depois', async () => {
      await setSystem(ADMIN, 'supervisor', SUP_DEFAULT.filter((p) => p !== 'reports.export'))
      await resetSystem(ADMIN, 'supervisor')
      const rows = (await db.query<{ action: string; metadata: Json }>(`SELECT action, metadata FROM wacrm.audit_test ORDER BY action DESC`)).rows
      expect(rows.map((r) => r.action)).toEqual(['role.system_reset', 'role.system_customized'])
      expect(rows[1].metadata).toMatchObject({ removed: ['reports.export'], added: [] })
      expect(rows[0].metadata).toMatchObject({ added: ['reports.export'] })
    })
  })

  describe('atribuição e convite', () => {
    it('admin atribui supervisor a operador; não muda outro admin; não dá admin; nunca a si', async () => {
      expect(await assign(ADMIN, AGENT, await sysRole('supervisor'))).toMatchObject({ compat_role: 'supervisor' })
      expect(detail(await fail(assign(ADMIN, ADMIN2, await sysRole('agent'))))).toEqual({ code: 'role_level' })
      expect(detail(await fail(assign(ADMIN, AGENT, await sysRole('admin'))))).toEqual({ code: 'role_level' })
      expect(detail(await fail(assign(ADMIN, ADMIN, await sysRole('agent'))))).toEqual({ code: 'role_level' })
      expect(await assign(OWNER, ADMIN2, await sysRole('agent'))).toMatchObject({ compat_role: 'agent' })
      // Operador tem inbox.receive_assignments, que o admin não tem: vale porque é do padrão de um cargo abaixo dele
      expect(await assign(ADMIN, SUP, await sysRole('agent'))).toMatchObject({ compat_role: 'agent' })
      expect(await createCustom(ADMIN, 'Fila', ['inbox.view', 'inbox.receive_assignments'])).toMatchObject({ compat_role: 'agent' })
    })

    it('role_assignable: abaixo do nível, da organização e sem escalada', async () => {
      expect(await svc(`SELECT wacrm.role_assignable($1, $2, $3) AS r`, [A, ADMIN, await sysRole('viewer')])).toBe('viewer')
      expect(detail(await fail(svc(`SELECT wacrm.role_assignable($1, $2, $3) AS r`, [A, ADMIN, await sysRole('admin')])))).toEqual({ code: 'role_level' })
      const rb = (await createCustom(OWNER_B, 'De B', ['inbox.view'], B)) as { id: string }
      expect((await fail(svc(`SELECT wacrm.role_assignable($1, $2, $3) AS r`, [A, ADMIN, rb.id]))).code).toBe('P0002')
    })

    it('convite guarda o cargo; de outra organização é recusado; no aceite o cargo é aplicado', async () => {
      const custom = (await createCustom(ADMIN, 'Atendimento', ['inbox.view', 'inbox.reply'])) as { id: string }
      const rb = (await createCustom(OWNER_B, 'De B', ['inbox.view'], B)) as { id: string }
      await expect(db.query(`INSERT INTO wacrm.account_invitations (account_id, token_hash, role, role_id, expires_at)
        VALUES ($1, 'h0', 'agent', $2, now() + interval '1 day')`, [A, rb.id])).rejects.toThrow(/não pertence a esta organização/)
      await expect(db.query(`INSERT INTO wacrm.account_invitations (account_id, token_hash, role, role_id, expires_at)
        VALUES ($1, 'h1', 'agent', $2, now() + interval '1 day')`, [A, await sysRole('owner')])).rejects.toThrow(/proprietário/)
      const inv = (await db.query<{ id: string }>(`INSERT INTO wacrm.account_invitations (account_id, token_hash, role, role_id, expires_at)
        VALUES ($1, 'h2', 'agent', $2, now() + interval '1 day') RETURNING id`, [A, custom.id])).rows[0].id
      // o que a redeem_invitation (048) faz: move o perfil com o `role` e marca o aceite
      await db.query(`UPDATE wacrm.profiles SET account_id = $1, account_role = 'agent' WHERE user_id = $2`, [A, NEWBIE])
      await db.query(`UPDATE wacrm.account_invitations SET accepted_at = now(), accepted_by_user_id = $1 WHERE id = $2`, [NEWBIE, inv])
      expect(await profile(NEWBIE)).toEqual({ account_role: 'agent', key: expect.stringMatching(/^custom_/) })
      expect(await hasPerm(NEWBIE, 'inbox.reply')).toBe(true)
      expect(await hasPerm(NEWBIE, 'inbox.close')).toBe(false)
    })
  })

  it('RPCs só para service_role; my_permissions segue o ajuste', async () => {
    await setSystem(ADMIN, 'agent', [...SYSTEM_ROLE_PERMISSIONS.agent].filter((p) => p !== 'calls.use'))
    await db.query(`SELECT set_config('test.uid', $1, false)`, [AGENT])
    const mine = (await db.query<{ p: string[] }>(`SELECT wacrm.my_permissions() AS p`)).rows[0].p
    expect(mine).not.toContain('calls.use')
    expect(mine).toContain('inbox.reply')
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`)
      try {
        await expect(db.query(`SELECT wacrm.reset_system_role_permissions('${A}', '${OWNER}', '${A}')`)).rejects.toThrow(/permission denied/)
      } finally {
        await db.exec('RESET ROLE')
      }
    }
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version IN ('318_roles_by_level', '319_invitation_role_id')`)).rows).toHaveLength(2)
  })
})
