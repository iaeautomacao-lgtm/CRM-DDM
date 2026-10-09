// Migrations 240/241/241b (PRD 20, fase 20.2): papéis como linhas, vínculo do perfil, sincronia account_role ⇄ role_id
// e has_perm(). PGlite com as migrations REAIS sobre um schema mínimo (accounts/profiles + a 169 real).
// Prova: o seed é idêntico ao catálogo de src/lib/auth/permissions.ts; o backfill; a sincronia nos dois sentidos;
// e a equivalência has_perm() × can() para os 5 papéis de sistema (a matriz dourada, agora no banco).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ACCOUNT_ROLES } from './roles'
import {
  PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  can,
  compatRoleFor,
  permissionDef,
  type Permission,
} from './permissions'

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

const ACC_A = '00000000-0000-0000-0000-00000000000a'
const ACC_B = '00000000-0000-0000-0000-00000000000b'
const uid = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`

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
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${ACC_A}', 'A'), ('${ACC_B}', 'B');
`

async function bootstrap(db: PGlite) {
  await db.exec(BOOTSTRAP)
  await db.exec(migration('169_profiles_lock_privileged_columns.sql')) // guard real (account_role/account_id)
  await db.exec(`GRANT SELECT ON wacrm.profiles, wacrm.accounts TO authenticated`) // em produção vem das policies/grants de leitura
}

const sqlList = (keys: readonly string[]) => keys.map((k) => `'${k}'`).join(',')

describe('migrations 240/241/241b — papéis como linhas, sincronia e has_perm', { timeout: 60_000 }, () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await bootstrap(db)
    await db.exec(migration('240_roles_foundation.sql'))
    await db.exec(migration('241_roles_functions.sql'))
    await db.exec(migration('241b_profiles_role_id_idx.sql'))
    await db.exec(migration('276_billing_permissions.sql')) // billing.view/manage (PRD 17.5): o catálogo do código já os tem
    await db.exec(migration('304_view_permission_keys.sql')) // campaigns.view/pipelines.view (§8 item 4): o catálogo do código já os tem
  }, 60_000)
  afterAll(async () => {
    await db.close()
  }, 60_000)
  beforeEach(async () => {
    await db.exec(`RESET ROLE; SELECT set_config('test.uid', '', false); DELETE FROM wacrm.profiles; DELETE FROM wacrm.account_roles WHERE account_id IS NOT NULL;`)
  })

  const addProfile = async (n: number, role: string, account = ACC_A) =>
    db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, $3::wacrm.account_role_enum)`, [uid(n), account, role])
  const profile = async (n: number) =>
    (await db.query<{ role: string; key: string | null; custom: boolean | null }>(
      `SELECT p.account_role::text AS role, r.key, (r.account_id IS NOT NULL) AS custom
         FROM wacrm.profiles p LEFT JOIN wacrm.account_roles r ON r.id = p.role_id WHERE p.user_id = $1`,
      [uid(n)],
    )).rows[0]
  const roleId = async (key: string, account: string | null = null) =>
    (await db.query<{ id: string }>(`SELECT id FROM wacrm.account_roles WHERE key = $1 AND account_id IS NOT DISTINCT FROM $2`, [key, account])).rows[0].id
  const asUser = async (n: number) => {
    await db.query(`SELECT set_config('test.uid', $1, false)`, [uid(n)])
  }

  // ── seed ────────────────────────────────────────────────────────────────────────────────────────────
  describe('seed idêntico ao catálogo de permissions.ts', () => {
    it('permission_catalog: mesmas chaves, rótulos, grupos, escopo, owner_only/grantable, dependências e ordem', async () => {
      const { rows } = await db.query<{
        key: string; label: string; description: string; group_name: string; scope: string
        owner_only: boolean; grantable: boolean; depends_on: string[]; sort: number
      }>(`SELECT * FROM wacrm.permission_catalog ORDER BY sort`)
      expect(rows.map((r) => r.key)).toEqual([...PERMISSIONS])
      for (const [i, row] of rows.entries()) {
        const def = permissionDef(PERMISSIONS[i])
        expect(row.label, row.key).toBe(def.label)
        expect(row.description, row.key).toBe(def.description)
        expect(row.group_name, row.key).toBe(def.group)
        expect(row.scope, row.key).toBe(def.scope === 'none' ? 'n/a' : def.scope)
        expect(row.owner_only, row.key).toBe(Boolean(def.ownerOnly))
        expect(row.grantable, row.key).toBe(!def.ownerOnly)
        expect(row.depends_on, row.key).toEqual([...(def.dependsOn ?? [])])
        expect(row.sort).toBe((i + 1) * 10)
      }
    })

    it('os 5 papéis de sistema: rank 5..1, compat = o próprio papel, sem account_id', async () => {
      const { rows } = await db.query<{ key: string; rank: number; compat_role: string; kind: string; account_id: string | null }>(
        `SELECT key, rank, compat_role, kind, account_id FROM wacrm.account_roles WHERE account_id IS NULL ORDER BY rank DESC`,
      )
      expect(rows).toEqual([
        { key: 'owner', rank: 5, compat_role: 'owner', kind: 'system', account_id: null },
        { key: 'admin', rank: 4, compat_role: 'admin', kind: 'system', account_id: null },
        { key: 'supervisor', rank: 3, compat_role: 'supervisor', kind: 'system', account_id: null },
        { key: 'agent', rank: 2, compat_role: 'agent', kind: 'system', account_id: null },
        { key: 'viewer', rank: 1, compat_role: 'viewer', kind: 'system', account_id: null },
      ])
    })

    it.each(ACCOUNT_ROLES)('role_permissions de %s == SYSTEM_ROLE_PERMISSIONS (conjunto de hoje)', async (role) => {
      const { rows } = await db.query<{ permission: string }>(
        `SELECT rp.permission FROM wacrm.role_permissions rp JOIN wacrm.account_roles r ON r.id = rp.role_id
          WHERE r.account_id IS NULL AND r.key = $1 ORDER BY 1`,
        [role],
      )
      expect(rows.map((r) => r.permission)).toEqual([...SYSTEM_ROLE_PERMISSIONS[role]].sort())
    })

    it('papel de sistema nenhum recebe chave fora do catálogo (FK) e ownerOnly só vai para o proprietário', async () => {
      const { rows } = await db.query<{ key: string; permission: string }>(
        `SELECT r.key, rp.permission FROM wacrm.role_permissions rp
           JOIN wacrm.account_roles r ON r.id = rp.role_id
           JOIN wacrm.permission_catalog c ON c.key = rp.permission
          WHERE c.owner_only AND r.key <> 'owner'`,
      )
      expect(rows).toEqual([])
    })
  })

  // ── sincronia ───────────────────────────────────────────────────────────────────────────────────────
  describe('trigger de sincronia account_role ⇄ role_id', () => {
    it('INSERT só com account_role (código antigo): role_id = papel de sistema correspondente', async () => {
      for (const [i, role] of ACCOUNT_ROLES.entries()) await addProfile(i + 1, role)
      for (const [i, role] of ACCOUNT_ROLES.entries()) expect(await profile(i + 1)).toEqual({ role, key: role, custom: false })
    })

    it('INSERT só com role_id (código novo): account_role = compat_role', async () => {
      await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role, role_id) VALUES ($1, $2, 'viewer', $3)`, [uid(1), ACC_A, await roleId('admin')])
      // role_id VENCE: o account_role passado ('viewer') é corrigido para o compat do papel
      expect(await profile(1)).toEqual({ role: 'admin', key: 'admin', custom: false })
    })

    it('UPDATE de account_role (RPC legada) leva o role_id junto', async () => {
      await addProfile(1, 'agent')
      await db.query(`UPDATE wacrm.profiles SET account_role = 'supervisor' WHERE user_id = $1`, [uid(1)])
      expect(await profile(1)).toEqual({ role: 'supervisor', key: 'supervisor', custom: false })
    })

    it('UPDATE de role_id leva o account_role junto', async () => {
      await addProfile(1, 'agent')
      await db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [uid(1), await roleId('admin')])
      expect(await profile(1)).toEqual({ role: 'admin', key: 'admin', custom: false })
    })

    it('UPDATE de role_id para NULL restaura o papel de sistema a partir do account_role', async () => {
      await addProfile(1, 'supervisor')
      await db.query(`UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = $1`, [uid(1)])
      expect(await profile(1)).toEqual({ role: 'supervisor', key: 'supervisor', custom: false })
    })

    it('UPDATE de outra coluna não mexe em nenhum dos dois lados', async () => {
      await addProfile(1, 'agent')
      const before = await profile(1)
      await db.query(`UPDATE wacrm.profiles SET full_name = 'Maria' WHERE user_id = $1`, [uid(1)])
      expect(await profile(1)).toEqual(before)
    })

    it('papel personalizado: role_id aponta para ele e account_role = compat; RPC legada devolve ao papel de sistema', async () => {
      await db.query(
        `INSERT INTO wacrm.account_roles (account_id, key, name, kind, rank, compat_role) VALUES ($1, 'cobranca', 'Cobrança', 'custom', 2, 'agent')`,
        [ACC_A],
      )
      await addProfile(1, 'viewer')
      await db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [uid(1), await roleId('cobranca', ACC_A)])
      expect(await profile(1)).toEqual({ role: 'agent', key: 'cobranca', custom: true })
      // código antigo muda só o enum → vira o papel de sistema, solta o personalizado
      await db.query(`UPDATE wacrm.profiles SET account_role = 'admin' WHERE user_id = $1`, [uid(1)])
      expect(await profile(1)).toEqual({ role: 'admin', key: 'admin', custom: false })
    })

    it('papel personalizado de OUTRA organização é recusado', async () => {
      await db.query(
        `INSERT INTO wacrm.account_roles (account_id, key, name, kind, rank, compat_role) VALUES ($1, 'outra', 'Outra', 'custom', 2, 'agent')`,
        [ACC_B],
      )
      await addProfile(1, 'agent', ACC_A)
      await expect(
        db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [uid(1), await roleId('outra', ACC_B)]),
      ).rejects.toThrow(/outra organização/)
    })

    it('role_id inexistente é recusado', async () => {
      await addProfile(1, 'agent')
      await expect(
        db.query(`UPDATE wacrm.profiles SET role_id = gen_random_uuid() WHERE user_id = $1`, [uid(1)]),
      ).rejects.toThrow()
    })

    it('usuário comum (authenticated) não grava role_id nem account_role (guards)', async () => {
      await addProfile(1, 'agent')
      await db.exec(`SET ROLE authenticated`)
      await expect(db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [uid(1), await roleId('owner')])).rejects.toThrow()
      await expect(db.query(`UPDATE wacrm.profiles SET account_role = 'owner' WHERE user_id = $1`, [uid(1)])).rejects.toThrow()
      // o que o navegador pode (nome/avatar) segue funcionando e não dispara a sincronia
      await db.query(`UPDATE wacrm.profiles SET full_name = 'Eu' WHERE user_id = $1`, [uid(1)])
      await db.exec(`RESET ROLE`)
      expect(await profile(1)).toEqual({ role: 'agent', key: 'agent', custom: false })
    })

    it('guard por trigger: mesmo COM grant de coluna, authenticated não grava role_id (defesa em profundidade)', async () => {
      await addProfile(1, 'agent')
      await db.exec(`GRANT UPDATE (role_id) ON wacrm.profiles TO authenticated; SET ROLE authenticated`)
      await expect(db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [uid(1), await roleId('owner')])).rejects.toThrow(
        /Alteração do papel do perfil não permitida/,
      )
      await db.exec(`RESET ROLE; REVOKE UPDATE (role_id) ON wacrm.profiles FROM authenticated`)
      expect(await profile(1)).toEqual({ role: 'agent', key: 'agent', custom: false })
    })

    it('authenticated só LÊ as tabelas novas (sem escrita)', async () => {
      await db.exec(`SET ROLE authenticated`)
      await expect(db.query(`INSERT INTO wacrm.role_permissions (role_id, permission) VALUES (gen_random_uuid(), 'inbox.view')`)).rejects.toThrow()
      await expect(db.query(`UPDATE wacrm.account_roles SET name = 'x'`)).rejects.toThrow()
      await expect(db.query(`DELETE FROM wacrm.permission_catalog`)).rejects.toThrow()
      await db.exec(`RESET ROLE`)
    })
  })

  // ── has_perm × can() ────────────────────────────────────────────────────────────────────────────────
  describe('equivalência has_perm() × can() (matriz dourada, 5 papéis)', () => {
    it.each(ACCOUNT_ROLES)('%s: has_perm == can() em TODAS as permissões e my_permissions == conjunto do papel', async (role) => {
      await addProfile(7, role)
      await asUser(7)
      for (const perm of PERMISSIONS) {
        const { rows } = await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm($1) AS ok`, [perm])
        expect(rows[0].ok, `${role} ${perm}`).toBe(can({ role }, perm))
      }
      const mine = await db.query<{ p: string[] }>(`SELECT wacrm.my_permissions() AS p`)
      expect(mine.rows[0].p).toEqual([...SYSTEM_ROLE_PERMISSIONS[role]].sort())
    })

    it('fail-closed: chave desconhecida, usuário sem perfil e sem sessão dão false / vazio', async () => {
      await addProfile(7, 'owner')
      await asUser(7)
      expect((await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm('nao.existe') AS ok`)).rows[0].ok).toBe(false)
      await asUser(99) // sem perfil
      expect((await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm('inbox.view') AS ok`)).rows[0].ok).toBe(false)
      expect((await db.query<{ p: string[] }>(`SELECT wacrm.my_permissions() AS p`)).rows[0].p).toEqual([])
      await db.query(`SELECT set_config('test.uid', '', false)`) // sem sessão
      expect((await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm('inbox.view') AS ok`)).rows[0].ok).toBe(false)
    })

    it('funciona para o usuário logado (SET ROLE authenticated), mesmo sem ler as tabelas direto', async () => {
      await addProfile(7, 'agent')
      await asUser(7)
      await db.exec(`SET ROLE authenticated`)
      expect((await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm('inbox.reply') AS ok`)).rows[0].ok).toBe(true)
      expect((await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm('campaigns.manage') AS ok`)).rows[0].ok).toBe(false)
      await db.exec(`RESET ROLE`)
    })

    it('papel personalizado: has_perm reflete o conjunto do papel (não o compat)', async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO wacrm.account_roles (account_id, key, name, kind, rank, compat_role) VALUES ($1, 'so_responde', 'Só responde', 'custom', 2, 'agent') RETURNING id`,
        [ACC_A],
      )
      await db.query(`INSERT INTO wacrm.role_permissions (role_id, permission) VALUES ($1, 'inbox.view'), ($1, 'inbox.reply')`, [rows[0].id])
      await addProfile(7, 'viewer')
      await db.query(`UPDATE wacrm.profiles SET role_id = $2 WHERE user_id = $1`, [uid(7), rows[0].id])
      await asUser(7)
      const has = async (p: string) => (await db.query<{ ok: boolean }>(`SELECT wacrm.has_perm($1) AS ok`, [p])).rows[0].ok
      expect(await has('inbox.reply')).toBe(true)
      expect(await has('inbox.close')).toBe(false) // o operador teria; o personalizado não
    })
  })

  // ── funções auxiliares ──────────────────────────────────────────────────────────────────────────────
  describe('role_rank() e compat_role_for()', () => {
    it('role_rank dos 5 papéis de sistema e NULL para id inexistente', async () => {
      for (const [key, rank] of [['owner', 5], ['admin', 4], ['supervisor', 3], ['agent', 2], ['viewer', 1]] as const) {
        const { rows } = await db.query<{ r: number }>(`SELECT wacrm.role_rank($1) AS r`, [await roleId(key)])
        expect(rows[0].r).toBe(rank)
      }
      expect((await db.query<{ r: number | null }>(`SELECT wacrm.role_rank(gen_random_uuid()) AS r`)).rows[0].r).toBeNull()
    })

    const SETS: Permission[][] = [
      [],
      ['dashboard.view'],
      ['inbox.view', 'inbox.reply'],
      ['monitoring.view_team'],
      ['reports.view_all'],
      ['reports.view_all', 'reports.export'],
      ['monitoring.view_all', 'monitoring.assign'],
      ['conversations.scope_all'],
      ['intelligence.scope_account'],
      ['campaigns.manage'],
      ['inbox.receive_assignments', 'automations.edit'],
      ['inbox.receive_assignments'],
      ['roles.manage'],
    ]
    it.each(SETS.map((s) => [s.join(', ') || '(vazio)', s] as const))('compat_role_for(%s) == compatRoleFor() do TypeScript', async (_name, perms) => {
      const { rows } = await db.query<{ r: string }>(`SELECT wacrm.compat_role_for(ARRAY[${sqlList(perms)}]::text[]) AS r`)
      // roles.manage é ownerOnly: nenhum papel não-owner contém ⇒ 'admin' (teto), igual ao TS
      expect(rows[0].r).toBe(compatRoleFor(perms))
    })

    it('chave desconhecida cai no teto (admin)', async () => {
      expect((await db.query<{ r: string }>(`SELECT wacrm.compat_role_for(ARRAY['nao.existe']) AS r`)).rows[0].r).toBe('admin')
      expect((await db.query<{ r: string }>(`SELECT wacrm.compat_role_for(NULL) AS r`)).rows[0].r).toBe('viewer')
    })
  })

  // ── idempotência / índice ───────────────────────────────────────────────────────────────────────────
  describe('idempotência', () => {
    it('rodar 240, 241 e 241b de novo não muda nada e não falha', async () => {
      const count = async () =>
        (await db.query<{ c: number; r: number; p: number }>(
          `SELECT (SELECT count(*)::int FROM wacrm.permission_catalog) AS c,
                  (SELECT count(*)::int FROM wacrm.account_roles) AS r,
                  (SELECT count(*)::int FROM wacrm.role_permissions) AS p`,
        )).rows[0]
      const before = await count()
      await db.exec(migration('240_roles_foundation.sql'))
      await db.exec(migration('241_roles_functions.sql'))
      await db.exec(migration('241b_profiles_role_id_idx.sql'))
      await db.exec(migration('276_billing_permissions.sql'))
      await db.exec(migration('304_view_permission_keys.sql')) // campaigns.view/pipelines.view (§8 item 4): o catálogo do código já os tem
      expect(await count()).toEqual(before)
    })

    it('o índice de role_id existe e é válido', async () => {
      const { rows } = await db.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_profiles_role_id'`,
      )
      expect(rows).toEqual([{ indisvalid: true }])
    })
  })
})

describe('migration 240 — backfill de perfis existentes e pré-check', { timeout: 60_000 }, () => {
  it('perfis criados ANTES da 240 recebem o papel de sistema certo e os dois lados concordam (SQL de verificação do cabeçalho)', async () => {
    const db = new PGlite()
    await bootstrap(db)
    for (const [i, role] of ACCOUNT_ROLES.entries()) {
      await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, $3::wacrm.account_role_enum)`, [uid(i + 1), ACC_A, role])
    }
    await db.exec(migration('240_roles_foundation.sql'))
    const orphans = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM wacrm.profiles WHERE role_id IS NULL`)
    expect(orphans.rows[0].c).toBe(0)
    const mismatch = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM wacrm.profiles p JOIN wacrm.account_roles r ON r.id = p.role_id WHERE r.compat_role <> p.account_role::text`,
    )
    expect(mismatch.rows[0].c).toBe(0)
    const { rows } = await db.query<{ role: string; key: string }>(
      `SELECT p.account_role::text AS role, r.key FROM wacrm.profiles p JOIN wacrm.account_roles r ON r.id = p.role_id ORDER BY r.rank`,
    )
    expect(rows.map((r) => [r.role, r.key])).toEqual(ACCOUNT_ROLES.map((r) => [r, r]))
    await db.close()
  })

  it('pré-check: sem wacrm.accounts aborta sem criar nada', async () => {
    const db = new PGlite()
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE SCHEMA wacrm;`)
    await expect(db.exec(migration('240_roles_foundation.sql'))).rejects.toThrow(/240: falta wacrm\.profiles/)
    await db.exec('ROLLBACK')
    const { rows } = await db.query<{ t: string | null }>(`SELECT to_regclass('wacrm.account_roles')::text AS t`)
    expect(rows[0].t).toBeNull()
    await db.close()
  })

  it('pré-check: enum com valor sem papel semeado aborta e desfaz', async () => {
    const db = new PGlite()
    await bootstrap(db)
    await db.exec(`ALTER TYPE wacrm.account_role_enum ADD VALUE 'consultor'`)
    await expect(db.exec(migration('240_roles_foundation.sql'))).rejects.toThrow(/sem papel de sistema semeado: consultor/)
    await db.exec('ROLLBACK')
    expect((await db.query<{ t: string | null }>(`SELECT to_regclass('wacrm.account_roles')::text AS t`)).rows[0].t).toBeNull()
    await db.close()
  })

  it('241 sem a 240 aborta', async () => {
    const db = new PGlite()
    await bootstrap(db)
    await expect(db.exec(migration('241_roles_functions.sql'))).rejects.toThrow(/241: falta a migration 240/)
    await db.close()
  })
})
