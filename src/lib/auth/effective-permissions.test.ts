// PRD 20 — permissões efetivas: papel de sistema sem consulta extra (cache), papel personalizado pelo banco (só chaves
// concedíveis, expandidas), fail-closed para papel de outra organização ou que não carrega.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SYSTEM_ROLE_PERMISSIONS } from './permissions'
import { RoleLoadError, resetSystemRoleIdsCache, resolveEffectivePermissions } from './effective-permissions'

type Res = { data?: unknown; error?: { message: string } | null }

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

const SYS = { data: [{ id: 's-agent' }, { id: 's-admin' }] }
const profile = (role_id: string | null) => ({ account_id: 'acc', account_role: 'agent' as const, role_id })

beforeEach(() => resetSystemRoleIdsCache())

describe('resolveEffectivePermissions', () => {
  it('sem role_id ou com papel de sistema: permissões do papel, e a lista de sistema só é lida uma vez', async () => {
    const f = fakeDb({ account_roles: SYS })
    expect((await resolveEffectivePermissions(f.db, profile(null))).permissions).toBe(SYSTEM_ROLE_PERMISSIONS.agent)
    const r = await resolveEffectivePermissions(f.db, profile('s-agent'))
    expect(r).toEqual({ permissions: SYSTEM_ROLE_PERMISSIONS.agent, customRole: null })
    await resolveEffectivePermissions(f.db, profile('s-admin'))
    expect(f.calls).toEqual(['account_roles']) // cache
  })

  it('personalizado: do banco, sem ownerOnly/future/desconhecida, expandido pelas implicações', async () => {
    const f = fakeDb({
      account_roles: [SYS, { data: [{ id: 'c1', key: 'custom_x', name: 'Cobrança', kind: 'custom', account_id: 'acc' }] }],
      role_permissions: {
        data: [{ permission: 'inbox.view' }, { permission: 'reports.view_all' }, { permission: 'roles.manage' }, { permission: 'integrations.manage' }, { permission: 'x.y' }],
      },
    })
    const r = await resolveEffectivePermissions(f.db, profile('c1'))
    expect(r.customRole).toEqual({ id: 'c1', key: 'custom_x', name: 'Cobrança' })
    expect([...r.permissions].sort()).toEqual(['inbox.view', 'reports.view_all', 'reports.view_team'])
  })

  it('fail-closed: papel de outra organização, inexistente ou erro de leitura', async () => {
    const other = fakeDb({ account_roles: [SYS, { data: [{ id: 'c1', key: 'k', name: 'n', kind: 'custom', account_id: 'outra' }] }] })
    await expect(resolveEffectivePermissions(other.db, profile('c1'))).rejects.toBeInstanceOf(RoleLoadError)
    resetSystemRoleIdsCache()
    await expect(resolveEffectivePermissions(fakeDb({ account_roles: [SYS, { data: [] }] }).db, profile('c1'))).rejects.toBeInstanceOf(RoleLoadError)
    resetSystemRoleIdsCache()
    const broken = fakeDb({ account_roles: [SYS, { data: [{ id: 'c1', key: 'k', name: 'n', kind: 'custom', account_id: 'acc' }] }], role_permissions: { error: { message: 'boom' } } })
    await expect(resolveEffectivePermissions(broken.db, profile('c1'))).rejects.toBeInstanceOf(RoleLoadError)
  })

  it('lista de sistema que falha não fica em cache; a consulta direta decide', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const f = fakeDb({ account_roles: [{ error: { message: 'off' } }, { data: [{ id: 's-agent', key: 'agent', name: 'Operador', kind: 'system', account_id: null }] }, SYS] })
    expect((await resolveEffectivePermissions(f.db, profile('s-agent'))).customRole).toBeNull()
    await resolveEffectivePermissions(f.db, profile('s-agent'))
    expect(f.calls).toEqual(['account_roles', 'account_roles', 'account_roles']) // tentou a lista de novo
  })
})
