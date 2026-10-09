// PRD 20 — serviço do papel personalizado: validação da entrada, mapeamento de erros do banco e listagem.
import { describe, expect, it, vi } from 'vitest'

import { MAX_CUSTOM_ROLES, SYSTEM_ROLE_PERMISSIONS } from '@/lib/auth/permissions'
import {
  CustomRoleError,
  assignMemberRole,
  createCustomRole,
  deleteCustomRole,
  listRoles,
  memberHasCustomRole,
  parseRoleInput,
  updateCustomRole,
} from './custom-roles'

/** Query builder falso: todo método encadeia; `await` devolve a resposta configurada para a tabela. */
function fakeDb(tables: Record<string, { data?: unknown; error?: unknown }>, rpc?: { data?: unknown; error?: unknown }) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = []
  const rpcCalls: [string, unknown][] = []
  const from = (table: string) => {
    const entry = { table, ops: [] as [string, unknown[]][] }
    calls.push(entry)
    const res = { data: tables[table]?.data ?? null, error: tables[table]?.error ?? null }
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'or', 'in', 'eq', 'is', 'limit']) {
      builder[op] = (...args: unknown[]) => (entry.ops.push([op, args]), builder)
    }
    builder.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, ko)
    return builder
  }
  const db = {
    from,
    rpc: async (name: string, args: unknown) => (rpcCalls.push([name, args]), { data: rpc?.data ?? null, error: rpc?.error ?? null }),
  }
  return { db: db as never, calls, rpcCalls }
}

const errOf = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as CustomRoleError

describe('parseRoleInput', () => {
  it('create: exige nome e permissões; remove duplicadas', () => {
    expect(parseRoleInput({ name: 'Cobrança', permissions: ['inbox.view', 'inbox.view', 'inbox.reply'] }, 'create')).toEqual({
      name: 'Cobrança',
      permissions: ['inbox.view', 'inbox.reply'],
    })
    for (const body of [null, 'x', {}, { name: ' ', permissions: ['inbox.view'] }, { name: 'X' }, { name: 'X', permissions: 'inbox.view' }]) {
      expect(() => parseRoleInput(body, 'create')).toThrow(CustomRoleError)
    }
  })

  it('permissões: vazio, desconhecida, ownerOnly, future e dependência faltando → 400 com a lista', () => {
    expect(() => parseRoleInput({ name: 'X', permissions: [] }, 'create')).toThrow(/ao menos uma/)
    try {
      parseRoleInput({ name: 'X', permissions: ['inbox.reply', 'roles.manage', 'integrations.manage', 'x.y'] }, 'create')
      expect.unreachable()
    } catch (e) {
      const err = e as CustomRoleError
      expect(err).toMatchObject({ status: 400, code: 'invalid_permissions' })
      expect(err.extra.errors?.map((x) => x.code).sort()).toEqual(['missing_dependency', 'not_grantable', 'owner_only', 'unknown_permission'])
    }
  })

  it('update: qualquer subconjunto, ao menos um campo; description null limpa; limites de tamanho', () => {
    expect(parseRoleInput({ name: 'Novo' }, 'update')).toEqual({ name: 'Novo' })
    expect(parseRoleInput({ description: null }, 'update')).toEqual({ description: '' })
    expect(() => parseRoleInput({}, 'update')).toThrow(/Nada para alterar/)
    expect(() => parseRoleInput({ name: 'x'.repeat(81) }, 'update')).toThrow(/1 a 80/)
    expect(() => parseRoleInput({ description: 'y'.repeat(301) }, 'update')).toThrow(/300/)
  })
})

describe('RPCs: argumentos e erros do banco', () => {
  const base = { accountId: 'acc', actorId: 'owner' }

  it('create/update/delete/assign passam conta e ator; update manda NULL no que não muda', async () => {
    const f = fakeDb({}, { data: { id: 'r1' } })
    await createCustomRole(f.db, { ...base, name: 'X', permissions: ['inbox.view'] })
    await updateCustomRole(f.db, { ...base, roleId: 'r1', name: 'Y' })
    await deleteCustomRole(f.db, { ...base, roleId: 'r1' })
    await assignMemberRole(f.db, { ...base, targetId: 'u1', roleId: 'r1' })
    expect(f.rpcCalls).toEqual([
      ['create_custom_role', { p_account: 'acc', p_actor: 'owner', p_name: 'X', p_description: null, p_permissions: ['inbox.view'] }],
      ['update_custom_role', { p_account: 'acc', p_actor: 'owner', p_role: 'r1', p_name: 'Y', p_description: null, p_permissions: null }],
      ['delete_custom_role', { p_account: 'acc', p_actor: 'owner', p_role: 'r1' }],
      ['assign_member_role', { p_account: 'acc', p_actor: 'owner', p_target: 'u1', p_role: 'r1' }],
    ])
  })

  it.each([
    [{ code: '42501', message: 'Só o proprietário' }, 403, 'forbidden'],
    [{ code: 'P0002', message: 'Papel não encontrado' }, 404, 'not_found'],
    [{ code: '22023', message: 'Escolha ao menos uma permissão' }, 400, 'invalid'],
    [{ code: '23505', message: 'Já existe' }, 409, 'name_taken'],
    [{ code: '54000', message: 'Limite' }, 409, 'limit_reached'],
    [{ code: '42883', message: 'function does not exist' }, 503, 'unavailable'],
    [{ code: 'XX000', message: 'boom' }, 500, 'internal'],
  ])('erro %o → %i %s', async (error, status, code) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const err = await errOf(createCustomRole(fakeDb({}, { error }).db, { ...base, name: 'X', permissions: ['inbox.view'] }))
    expect(err).toBeInstanceOf(CustomRoleError)
    expect(err).toMatchObject({ status, code })
  })

  it('22023 com DETAIL jsonb vira invalid_permissions com a lista; 55006 traz a contagem de membros', async () => {
    const detail = JSON.stringify([{ code: 'owner_only', permission: 'roles.manage' }])
    const e1 = await errOf(createCustomRole(fakeDb({}, { error: { code: '22023', message: 'Permissões inválidas', details: detail } }).db, { ...base }))
    expect(e1).toMatchObject({ code: 'invalid_permissions', extra: { errors: [{ code: 'owner_only', permission: 'roles.manage' }] } })
    const e2 = await errOf(deleteCustomRole(fakeDb({}, { error: { code: '55006', message: 'em uso por 3', details: '3' } }).db, { ...base, roleId: 'r' }))
    expect(e2).toMatchObject({ status: 409, code: 'role_in_use', extra: { members: 3 } })
  })
})

describe('listRoles', () => {
  it('sistema (permissões do TS, rank desc) e depois personalizados por nome, com membros e limite', async () => {
    const f = fakeDb({
      account_roles: {
        data: [
          { id: 's-agent', account_id: null, key: 'agent', name: 'Operador', description: null, kind: 'system', rank: 2, compat_role: 'agent', created_at: null, updated_at: null },
          { id: 's-owner', account_id: null, key: 'owner', name: 'Proprietário', description: null, kind: 'system', rank: 5, compat_role: 'owner', created_at: null, updated_at: null },
          { id: 'c-2', account_id: 'acc', key: 'custom_b', name: 'Zelador', description: 'z', kind: 'custom', rank: 2, compat_role: 'agent', created_at: 't', updated_at: 't' },
          { id: 'c-1', account_id: 'acc', key: 'custom_a', name: 'Cobrança', description: null, kind: 'custom', rank: 3, compat_role: 'supervisor', created_at: 't', updated_at: 't' },
        ],
      },
      role_permissions: { data: [{ role_id: 'c-1', permission: 'reports.view_team' }, { role_id: 'c-1', permission: 'inbox.view' }, { role_id: 'c-2', permission: 'contacts.view' }] },
      profiles: { data: [{ user_id: 'u1', role_id: 'c-1' }, { user_id: 'u2', role_id: 'c-1' }, { user_id: 'u3', role_id: 's-agent' }, { user_id: 'u4', role_id: null }] },
    })
    const out = await listRoles(f.db, 'acc')
    expect(out.roles.map((r) => r.id)).toEqual(['s-owner', 's-agent', 'c-1', 'c-2'])
    expect(out.roles[1].permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS.agent].sort())
    expect(out.roles[2]).toMatchObject({ kind: 'custom', compat_role: 'supervisor', permissions: ['inbox.view', 'reports.view_team'], member_count: 2, member_ids: ['u1', 'u2'] })
    expect(out.roles[1]).toMatchObject({ member_count: 1, member_ids: ['u3'] })
    expect(out.limits).toEqual({ max_custom_roles: MAX_CUSTOM_ROLES, custom_roles: 2 })
    // escopo: só sistema + a organização; perfis só da organização
    expect(f.calls.find((c) => c.table === 'account_roles')!.ops).toContainEqual(['or', ['account_id.is.null,account_id.eq.acc']])
    expect(f.calls.find((c) => c.table === 'profiles')!.ops).toContainEqual(['eq', ['account_id', 'acc']])
  })
})

describe('memberHasCustomRole', () => {
  it('true só quando o role_id do membro é personalizado', async () => {
    expect(await memberHasCustomRole(fakeDb({ profiles: { data: [{ role_id: 'r' }] }, account_roles: { data: [{ kind: 'custom' }] } }).db, 'acc', 'u')).toBe(true)
    expect(await memberHasCustomRole(fakeDb({ profiles: { data: [{ role_id: 'r' }] }, account_roles: { data: [{ kind: 'system' }] } }).db, 'acc', 'u')).toBe(false)
    expect(await memberHasCustomRole(fakeDb({ profiles: { data: [] } }).db, 'acc', 'u')).toBe(false)
  })
})
