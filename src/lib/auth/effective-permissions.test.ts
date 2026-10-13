// PRD 20 + TASK5 — permissões efetivas: cargo de sistema pelo padrão OU pelo ajuste da organização (318), personalizado pelo
// banco (só chaves concedíveis, expandidas), nível do cargo e fail-closed para cargo de outra organização ou que não carrega.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SYSTEM_ROLE_PERMISSIONS } from './permissions'
import { RoleLoadError, resetSystemRoleIdsCache, resolveEffectivePermissions, roleLevel } from './effective-permissions'

type Res = { data?: unknown; error?: { message: string; code?: string } | null }

function fakeDb(responses: Record<string, Res | Res[]>) {
  const calls: string[] = []
  const from = (table: string) => {
    calls.push(table)
    const r = responses[table]
    const res = Array.isArray(r) ? (r.shift() ?? {}) : (r ?? {})
    const b: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'is', 'limit']) b[op] = () => b
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: res.data ?? null, error: res.error ?? null }).then(ok)
    return b
  }
  return { db: { from } as never, calls }
}

const SYS = { data: [{ id: 's-agent', key: 'agent' }, { id: 's-sup', key: 'supervisor' }, { id: 's-owner', key: 'owner' }] }
const NO_OVERRIDE = { data: [] }
const profile = (role_id: string | null, account_role: 'agent' | 'supervisor' | 'admin' | 'owner' = 'agent') => ({ account_id: 'acc', account_role, role_id })

beforeEach(() => resetSystemRoleIdsCache())

describe('resolveEffectivePermissions', () => {
  it('sem role_id: padrão do papel; cargo de sistema sem ajuste: padrão; a lista de sistema só é lida uma vez', async () => {
    const f = fakeDb({ account_roles: SYS, account_role_overrides: [NO_OVERRIDE, NO_OVERRIDE] })
    expect(await resolveEffectivePermissions(f.db, profile(null))).toEqual({
      permissions: SYSTEM_ROLE_PERMISSIONS.agent, customRole: null, roleId: null, level: 2, customized: false, systemKey: 'agent',
    })
    expect(await resolveEffectivePermissions(f.db, profile('s-agent'))).toEqual({
      permissions: SYSTEM_ROLE_PERMISSIONS.agent, customRole: null, roleId: 's-agent', level: 2, customized: false, systemKey: 'agent',
    })
    await resolveEffectivePermissions(f.db, profile('s-sup', 'supervisor'))
    expect(f.calls.filter((t) => t === 'account_roles')).toHaveLength(1) // cache
  })

  it('cargo de sistema AJUSTADO na organização: o conjunto do ajuste (expandido, sem ownerOnly), nível e chave do cargo', async () => {
    const f = fakeDb({
      account_roles: SYS,
      account_role_overrides: { data: [{ permissions: ['inbox.view', 'reports.view_all', 'campaigns.manage', 'account.delete'] }] },
    })
    const r = await resolveEffectivePermissions(f.db, profile('s-sup', 'admin'))
    expect([...r.permissions].sort()).toEqual(['campaigns.manage', 'inbox.view', 'reports.view_all', 'reports.view_team'])
    expect(r).toMatchObject({ customized: true, level: 3, systemKey: 'supervisor', roleId: 's-sup' })
  })

  it('proprietário: sempre o padrão (nem consulta ajuste); banco sem a 318: padrão', async () => {
    const f = fakeDb({ account_roles: SYS })
    expect(await resolveEffectivePermissions(f.db, profile('s-owner', 'owner'))).toMatchObject({ level: 5, customized: false, systemKey: 'owner' })
    expect(f.calls).toEqual(['account_roles'])
    resetSystemRoleIdsCache()
    const g = fakeDb({ account_roles: SYS, account_role_overrides: { error: { message: 'relation does not exist', code: '42P01' } } })
    expect((await resolveEffectivePermissions(g.db, profile('s-agent'))).permissions).toBe(SYSTEM_ROLE_PERMISSIONS.agent)
  })

  it('personalizado: do banco, sem ownerOnly/future/não concedível/desconhecida, expandido; nível até 3,5', async () => {
    const f = fakeDb({
      account_roles: [SYS, { data: [{ id: 'c1', key: 'custom_x', name: 'Cobrança', kind: 'custom', account_id: 'acc', rank: 4 }] }],
      role_permissions: {
        data: [{ permission: 'inbox.view' }, { permission: 'reports.view_all' }, { permission: 'roles.manage' }, { permission: 'integrations.manage' }, { permission: 'x.y' }],
      },
    })
    const r = await resolveEffectivePermissions(f.db, profile('c1'))
    expect(r.customRole).toEqual({ id: 'c1', key: 'custom_x', name: 'Cobrança' })
    expect([...r.permissions].sort()).toEqual(['inbox.view', 'reports.view_all', 'reports.view_team'])
    expect(r).toMatchObject({ level: 3.5, systemKey: null })
  })

  it('fail-closed: papel de outra organização, inexistente, erro de leitura ou erro no ajuste', async () => {
    const other = fakeDb({ account_roles: [SYS, { data: [{ id: 'c1', key: 'k', name: 'n', kind: 'custom', account_id: 'outra', rank: 2 }] }] })
    await expect(resolveEffectivePermissions(other.db, profile('c1'))).rejects.toBeInstanceOf(RoleLoadError)
    resetSystemRoleIdsCache()
    await expect(resolveEffectivePermissions(fakeDb({ account_roles: [SYS, { data: [] }] }).db, profile('c1'))).rejects.toBeInstanceOf(RoleLoadError)
    resetSystemRoleIdsCache()
    const broken = fakeDb({
      account_roles: [SYS, { data: [{ id: 'c1', key: 'k', name: 'n', kind: 'custom', account_id: 'acc', rank: 2 }] }],
      role_permissions: { error: { message: 'boom' } },
    })
    await expect(resolveEffectivePermissions(broken.db, profile('c1'))).rejects.toBeInstanceOf(RoleLoadError)
    resetSystemRoleIdsCache()
    const ov = fakeDb({ account_roles: SYS, account_role_overrides: { error: { message: 'timeout', code: '57014' } } })
    await expect(resolveEffectivePermissions(ov.db, profile('s-agent'))).rejects.toBeInstanceOf(RoleLoadError)
  })

  it('lista de sistema que falha não fica em cache; a consulta direta decide', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const f = fakeDb({
      account_roles: [{ error: { message: 'off' } }, { data: [{ id: 's-agent', key: 'agent', name: 'Operador', kind: 'system', account_id: null, rank: 2 }] }, SYS],
      account_role_overrides: [NO_OVERRIDE, NO_OVERRIDE],
    })
    expect((await resolveEffectivePermissions(f.db, profile('s-agent'))).customRole).toBeNull()
    await resolveEffectivePermissions(f.db, profile('s-agent'))
    expect(f.calls.filter((t) => t === 'account_roles')).toHaveLength(3) // tentou a lista de novo
  })

  it('roleLevel = wacrm.role_level (318)', () => {
    expect([roleLevel('system', 5), roleLevel('system', 2), roleLevel('custom', 4), roleLevel('custom', 3), roleLevel('custom', 1)]).toEqual([5, 2, 3.5, 3.5, 1.5])
  })
})
