// Migrations 312/313 (PRD 20 — papel personalizado). PGlite com as migrations REAIS 169, 240, 241, 241b, 276, 312 e 313.
// Prova: validação do banco = validação do TS (validateCustomRolePermissions/isGrantableToCustomRole/expandPermissions);
// só o proprietário cria/edita/apaga/atribui; limite de 20; nome único; apagar em uso é recusado; editar permissões
// recalcula o compat e o account_role dos membros SEM tirá-los do papel; has_perm segue o papel; papel de outra organização
// nunca fica no perfil.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  compatRoleFor,
  expandPermissions,
  isGrantableToCustomRole,
  permissionDef,
  validateCustomRolePermissions,
  type Permission,
} from '@/lib/auth/permissions'

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const OWNER = '00000000-0000-0000-0000-000000000101'
const ADMIN = '00000000-0000-0000-0000-000000000102'
const AGENT = '00000000-0000-0000-0000-000000000103'
const AGENT2 = '00000000-0000-0000-0000-000000000104'
const OWNER_B = '00000000-0000-0000-0000-000000000201'

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; -- como no Supabase
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
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
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
const create = (name: string, perms: string[], actor = OWNER, account = A, description: string | null = null) =>
  svc(`SELECT wacrm.create_custom_role($1, $2, $3, $4, $5::text[]) AS r`, [account, actor, name, description, perms])
const update = (role: string, patch: { name?: string; description?: string; perms?: string[] }, actor = OWNER, account = A) =>
  svc(`SELECT wacrm.update_custom_role($1, $2, $3, $4, $5, $6::text[]) AS r`, [
    account, actor, role, patch.name ?? null, patch.description ?? null, patch.perms ?? null,
  ])
const remove = (role: string, actor = OWNER, account = A) =>
  svc(`SELECT wacrm.delete_custom_role($1, $2, $3) AS r`, [account, actor, role])
const assign = (target: string, role: string, actor = OWNER, account = A) =>
  svc(`SELECT wacrm.assign_member_role($1, $2, $3, $4) AS r`, [account, actor, target, role])

const systemRoleId = async (key: string) =>
  (await db.query<{ id: string }>(`SELECT id FROM wacrm.account_roles WHERE account_id IS NULL AND key = $1`, [key])).rows[0].id
const profile = async (user: string) =>
  (
    await db.query<{ account_role: string; role_id: string; kind: string }>(
      `SELECT p.account_role::text AS account_role, p.role_id, r.kind FROM wacrm.profiles p JOIN wacrm.account_roles r ON r.id = p.role_id WHERE p.user_id = $1`,
      [user],
    )
  ).rows[0]
const rolePerms = async (role: string) =>
  (await db.query<{ permission: string }>(`SELECT permission FROM wacrm.role_permissions WHERE role_id = $1 ORDER BY 1`, [role])).rows.map((r) => r.permission)
const hasPerm = async (user: string, perm: string) => {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [user])
  return (await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm($1) AS ok`, [perm])).rows[0].ok
}
/** Erros do banco como conjunto comparável ao TS (chaves em ordem: o jsonb não guarda a ordem). */
const norm = (e: object) => JSON.stringify(e, Object.keys(e).sort())
const dbErrors = async (perms: string[]) =>
  (await svc<Json[]>(`SELECT wacrm.custom_role_permission_errors($1::text[]) AS r`, [perms])).map(norm).sort()
const tsErrors = (perms: string[]) => validateCustomRolePermissions(perms).map(norm).sort()

describe('migrations 312/313 — papel personalizado', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(BOOTSTRAP)
    await db.exec(migration('169_profiles_lock_privileged_columns.sql'))
    for (const f of ['240_roles_foundation.sql', '241_roles_functions.sql', '241b_profiles_role_id_idx.sql', '276_billing_permissions.sql']) {
      await db.exec(migration(f))
    }
    await db.exec(migration('312_custom_role_validation.sql'))
    await db.exec(migration('313_custom_roles.sql'))
    await db.exec(migration('312_custom_role_validation.sql')) // idempotentes
    await db.exec(migration('313_custom_roles.sql'))
  }, 120_000)
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await db.exec(`RESET ROLE; DELETE FROM wacrm.profiles; DELETE FROM wacrm.account_roles WHERE account_id IS NOT NULL;`)
    await db.exec(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES
      ('${OWNER}', '${A}', 'owner'), ('${ADMIN}', '${A}', 'admin'), ('${AGENT}', '${A}', 'agent'), ('${AGENT2}', '${A}', 'agent'),
      ('${OWNER_B}', '${B}', 'owner')`)
  })

  describe('312 — validação igual à do TS', () => {
    it('grantable = isGrantableToCustomRole para todas as chaves (ownerOnly e future fora)', async () => {
      const rows = (await db.query<{ key: string; grantable: boolean }>(`SELECT key, grantable FROM wacrm.permission_catalog`)).rows
      expect(rows.map((r) => r.key).sort()).toEqual([...PERMISSIONS].sort())
      for (const r of rows) expect(r.grantable, r.key).toBe(isGrantableToCustomRole(r.key))
      expect(rows.filter((r) => !r.grantable).map((r) => r.key)).toContain('integrations.manage')
    })

    it('expand_permissions = expandPermissions, chave a chave', async () => {
      for (const key of PERMISSIONS) {
        const got = await svc<string[]>(`SELECT wacrm.expand_permissions(ARRAY[$1]::text[]) AS r`, [key])
        expect(got, key).toEqual([...expandPermissions([key])].sort())
      }
    })

    it('custom_role_permission_errors = validateCustomRolePermissions', async () => {
      const cases: string[][] = [
        [],
        ['inbox.reply'],
        ['inbox.view', 'inbox.reply'],
        ['nada.disso', 'roles.manage', 'ownership.transfer', 'inbox.view'],
        ['integrations.manage'],
        ['reports.view_all', 'reports.export'],
        ['monitoring.view_all', 'monitoring.assign'],
        ['monitoring.assign'],
        ['exports.manage', 'reports.export'],
        ['billing.manage'],
        ...(['admin', 'supervisor', 'agent', 'viewer'] as const).map((r) => [...SYSTEM_ROLE_PERMISSIONS[r]].filter((p) => !permissionDef(p).future)),
      ]
      for (const perms of cases) expect(await dbErrors(perms), perms.join(',')).toEqual(tsErrors(perms))
    })
  })

  describe('313 — criar', () => {
    it('proprietário cria: permissões gravadas expandidas, compat igual ao TS, has_perm do membro segue o papel', async () => {
      const perms: Permission[] = ['inbox.view', 'inbox.reply', 'reports.view_all']
      const r = await create('  Operador   sênior ', perms, OWNER, A, 'Atende e vê relatórios')
      expect(r.compat_role).toBe(compatRoleFor(perms))
      expect(r.compat_role).toBe('admin') // reports.view_all só existe a partir do admin
      expect(await rolePerms(r.id as string)).toEqual([...expandPermissions(perms)].sort())
      const row = (await db.query<Json>(`SELECT name, description, kind, rank, created_by, key FROM wacrm.account_roles WHERE id = $1`, [r.id])).rows[0]
      expect(row).toMatchObject({ name: 'Operador sênior', description: 'Atende e vê relatórios', kind: 'custom', rank: 4, created_by: OWNER })
      expect(row.key).toMatch(/^custom_[0-9a-f]{12}$/)

      await assign(AGENT, r.id as string)
      expect(await hasPerm(AGENT, 'reports.view_team')).toBe(true) // implicada
      expect(await hasPerm(AGENT, 'inbox.close')).toBe(false) // o compat (admin) tem; o papel não
    })

    it('só o proprietário; nunca de outra organização', async () => {
      await expect(create('X', ['inbox.view'], ADMIN)).rejects.toMatchObject({ code: '42501' })
      await expect(create('X', ['inbox.view'], OWNER_B, A)).rejects.toMatchObject({ code: '42501' })
      await expect(create('X', ['inbox.view'], AGENT)).rejects.toMatchObject({ code: '42501' })
    })

    it('recusa vazio, permissões inválidas (DETAIL com a lista), nome vazio/longo, descrição longa', async () => {
      await expect(create('X', [])).rejects.toMatchObject({ code: '22023', message: expect.stringMatching(/ao menos uma/) })
      const err = (await create('X', ['inbox.reply', 'roles.manage']).catch((e: unknown) => e)) as { code: string; detail: string }
      expect(err.code).toBe('22023')
      expect(JSON.parse(err.detail).map((e: Json) => e.code).sort()).toEqual(['missing_dependency', 'owner_only'])
      await expect(create('X', ['integrations.manage'])).rejects.toMatchObject({ code: '22023' })
      await expect(create('   ', ['inbox.view'])).rejects.toMatchObject({ code: '22023' })
      await expect(create('x'.repeat(81), ['inbox.view'])).rejects.toMatchObject({ code: '22023' })
      await expect(create('X', ['inbox.view'], OWNER, A, 'y'.repeat(301))).rejects.toMatchObject({ code: '22023' })
    })

    it('nome único na organização (sem diferenciar maiúsculas/espaços) e diferente dos papéis padrão; outra organização pode repetir', async () => {
      await create('Cobrança', ['inbox.view'])
      await expect(create(' cobrança ', ['inbox.view'])).rejects.toMatchObject({ code: '23505' })
      await expect(create('supervisor', ['inbox.view'])).rejects.toMatchObject({ code: '23505' })
      await expect(create('Operador', ['inbox.view'])).rejects.toMatchObject({ code: '23505' })
      await expect(create('Cobrança', ['inbox.view'], OWNER_B, B)).resolves.toMatchObject({ compat_role: 'agent' })
    })

    it('limite de 20 por organização', async () => {
      for (let i = 1; i <= 20; i++) await create(`Papel ${i}`, ['contacts.view'])
      await expect(create('Papel 21', ['contacts.view'])).rejects.toMatchObject({ code: '54000' })
      await expect(create('Papel 21', ['contacts.view'], OWNER_B, B)).resolves.toBeTruthy()
    })
  })

  describe('313 — editar', () => {
    it('trocar permissões recalcula o compat e o account_role dos membros, que CONTINUAM no papel', async () => {
      const r = await create('Atendimento', ['inbox.view', 'inbox.reply'])
      expect(r.compat_role).toBe('agent')
      await assign(AGENT, r.id as string)
      await assign(AGENT2, r.id as string)
      const out = await update(r.id as string, { perms: ['inbox.view', 'inbox.reply', 'reports.view_team'] })
      expect(out).toMatchObject({ compat_role: 'supervisor', previous_compat_role: 'agent', members_updated: 2 })
      for (const u of [AGENT, AGENT2]) expect(await profile(u)).toMatchObject({ account_role: 'supervisor', role_id: r.id, kind: 'custom' })
      expect(await hasPerm(AGENT, 'reports.view_team')).toBe(true)
      // tirar a permissão volta o compat e some do has_perm
      expect(await update(r.id as string, { perms: ['inbox.view', 'inbox.reply'] })).toMatchObject({ compat_role: 'agent', members_updated: 2 })
      expect(await profile(AGENT)).toMatchObject({ account_role: 'agent', role_id: r.id })
      expect(await hasPerm(AGENT, 'reports.view_team')).toBe(false)
    })

    it('nome e descrição (NULL mantém, vazio limpa); compat igual não mexe nos membros', async () => {
      const r = await create('Antigo', ['contacts.view'], OWNER, A, 'desc')
      expect(await update(r.id as string, { name: 'Novo' })).toMatchObject({ members_updated: 0 })
      expect(await update(r.id as string, { description: '' })).toBeTruthy()
      const row = (await db.query<Json>(`SELECT name, description, updated_by FROM wacrm.account_roles WHERE id = $1`, [r.id])).rows[0]
      expect(row).toEqual({ name: 'Novo', description: null, updated_by: OWNER })
      await create('Outro', ['contacts.view'])
      await expect(update(r.id as string, { name: 'OUTRO' })).rejects.toMatchObject({ code: '23505' })
      await expect(update(r.id as string, { name: 'novo' })).resolves.toBeTruthy() // o próprio nome (outra caixa) pode
    })

    it('só o proprietário; papel de sistema ou de outra organização = não encontrado', async () => {
      const r = await create('X', ['contacts.view'])
      await expect(update(r.id as string, { name: 'Y' }, ADMIN)).rejects.toMatchObject({ code: '42501' })
      await expect(update(await systemRoleId('agent'), { name: 'Y' })).rejects.toMatchObject({ code: 'P0002' })
      await expect(update(r.id as string, { name: 'Y' }, OWNER_B, B)).rejects.toMatchObject({ code: 'P0002' })
      await expect(update(r.id as string, { perms: ['account.delete'] })).rejects.toMatchObject({ code: '22023' })
    })
  })

  describe('313 — atribuir e apagar', () => {
    it('atribui personalizado ou de sistema; nunca o proprietário, a si mesmo, papel de outra organização ou "proprietário"', async () => {
      const r = await create('X', ['contacts.view'])
      expect(await assign(AGENT, r.id as string)).toMatchObject({ role_id: r.id, compat_role: 'viewer', previous_role_id: await systemRoleId('agent') })
      expect(await profile(AGENT)).toMatchObject({ account_role: 'viewer', role_id: r.id })
      expect(await assign(AGENT, await systemRoleId('supervisor'))).toMatchObject({ compat_role: 'supervisor' })
      expect(await profile(AGENT)).toMatchObject({ account_role: 'supervisor', kind: 'system' })

      await expect(assign(OWNER, r.id as string)).rejects.toMatchObject({ code: '42501' }) // o próprio (proprietário)
      await expect(assign(AGENT, r.id as string, ADMIN)).rejects.toMatchObject({ code: '42501' })
      await expect(assign(AGENT, await systemRoleId('owner'))).rejects.toMatchObject({ code: '22023' })
      const rb = await create('Y', ['contacts.view'], OWNER_B, B)
      await expect(assign(AGENT, rb.id as string)).rejects.toMatchObject({ code: 'P0002' })
      await expect(assign(OWNER_B, r.id as string)).rejects.toMatchObject({ code: 'P0002' }) // membro de outra organização
    })

    it('apagar papel em uso é recusado com a contagem; depois de mover os membros, apaga (e as permissões somem)', async () => {
      const r = await create('X', ['contacts.view'])
      await assign(AGENT, r.id as string)
      await assign(AGENT2, r.id as string)
      const err = (await remove(r.id as string).catch((e: unknown) => e)) as { code: string; detail: string; message: string }
      expect(err).toMatchObject({ code: '55006', detail: '2' })
      expect(err.message).toMatch(/2 membro/)
      await assign(AGENT, await systemRoleId('agent'))
      await assign(AGENT2, await systemRoleId('agent'))
      await expect(remove(r.id as string, ADMIN)).rejects.toMatchObject({ code: '42501' })
      expect(await remove(r.id as string)).toEqual({ id: r.id, name: 'X' })
      expect(await rolePerms(r.id as string)).toEqual([])
      await expect(remove(r.id as string)).rejects.toMatchObject({ code: 'P0002' })
      await expect(remove(await systemRoleId('viewer'))).rejects.toMatchObject({ code: 'P0002' })
    })
  })

  describe('313 — trigger de sincronia', () => {
    it('RPC legada com OUTRO papel tira do personalizado; com o mesmo compat mantém', async () => {
      const r = await create('X', ['inbox.view', 'inbox.reply'])
      await assign(AGENT, r.id as string)
      await db.query(`UPDATE wacrm.profiles SET account_role = 'agent' WHERE user_id = $1`, [AGENT])
      expect(await profile(AGENT)).toMatchObject({ role_id: r.id })
      await db.query(`UPDATE wacrm.profiles SET account_role = 'supervisor' WHERE user_id = $1`, [AGENT])
      expect(await profile(AGENT)).toMatchObject({ account_role: 'supervisor', kind: 'system' })
    })

    it('membro que muda de organização perde o papel personalizado (volta ao de sistema do account_role)', async () => {
      const r = await create('X', ['inbox.view', 'inbox.reply'])
      await assign(AGENT, r.id as string)
      await db.query(`UPDATE wacrm.profiles SET account_id = $1 WHERE user_id = $2`, [B, AGENT])
      expect(await profile(AGENT)).toMatchObject({ account_role: 'agent', role_id: await systemRoleId('agent'), kind: 'system' })
    })
  })

  it('RPCs fechadas para anon/authenticated; registradas', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`)
      try {
        await expect(db.query(`SELECT wacrm.create_custom_role('${A}', '${OWNER}', 'X', NULL, ARRAY['inbox.view'])`)).rejects.toThrow(/permission denied/)
        await expect(db.query(`SELECT wacrm.assign_member_role('${A}', '${OWNER}', '${AGENT}', '${A}')`)).rejects.toThrow(/permission denied/)
        await expect(db.query(`SELECT wacrm.custom_role_permission_errors(ARRAY['x'])`)).rejects.toThrow(/permission denied/)
      } finally {
        await db.exec('RESET ROLE')
      }
    }
    const v = (await db.query<{ version: string }>(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '31%' ORDER BY 1`)).rows
    expect(v.map((x) => x.version)).toEqual(['312_custom_role_validation', '313_custom_roles'])
  })
})

describe('313 — ROLLBACK do cabeçalho', { timeout: 120_000 }, () => {
  it('executado literalmente, devolve profiles_sync_role à versão da 240 e remove as RPCs e o índice', async () => {
    const pg = new PGlite()
    try {
      await pg.exec(BOOTSTRAP)
      await pg.exec(migration('169_profiles_lock_privileged_columns.sql'))
      for (const f of ['240_roles_foundation.sql', '241_roles_functions.sql', '241b_profiles_role_id_idx.sql', '276_billing_permissions.sql']) {
        await pg.exec(migration(f))
      }
      const def = async () =>
        (await pg.query<{ d: string }>(`SELECT pg_get_functiondef('wacrm.profiles_sync_role()'::regprocedure) AS d`)).rows[0].d
      const from240 = await def()
      await pg.exec(migration('312_custom_role_validation.sql'))
      await pg.exec(migration('313_custom_roles.sql'))
      expect(await def()).not.toBe(from240)

      // bloco "-- ROLLBACK ... --   COMMIT;" do cabeçalho, sem o prefixo de comentário
      const header = migration('313_custom_roles.sql').split('\n')
      const start = header.findIndex((l) => l.startsWith('-- ROLLBACK'))
      const end = header.findIndex((l, i) => i > start && l.trim() === '--   COMMIT;')
      const sql = header
        .slice(start + 1, end + 1)
        .map((l) => l.replace(/^-- {3}/, '').replace(/^--$/, '')) // linha vazia do corpo vira '--' no cabeçalho
        .join('\n')
      await pg.exec(sql)

      expect(await def()).toBe(from240)
      const left = await pg.query(
        `SELECT 1 FROM pg_proc WHERE proname IN ('create_custom_role','update_custom_role','delete_custom_role','assign_member_role','custom_role_assert_owner','custom_role_check_name')`,
      )
      expect(left.rows).toHaveLength(0)
      expect((await pg.query(`SELECT to_regclass('wacrm.uq_account_roles_custom_name') AS r`)).rows).toEqual([{ r: null }])
      expect((await pg.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '313_custom_roles'`)).rows).toHaveLength(0)
    } finally {
      await pg.close()
    }
  })
})
