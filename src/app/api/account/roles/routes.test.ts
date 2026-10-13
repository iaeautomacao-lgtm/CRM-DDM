// PRD 20 — rotas do papel personalizado: /api/account/roles, /api/account/roles/[roleId] e
// /api/account/members/[userId]/role. Permissões (members.view para listar; roles.manage — só o proprietário — para o
// resto), validação do corpo antes do banco e tradução dos erros do serviço.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { can, type Permission } from '@/lib/auth/permissions'
import type { AccountRole } from '@/lib/auth/roles'

const ME = '00000000-0000-0000-0000-0000000000a1'
const OTHER = '00000000-0000-0000-0000-0000000000b2'
const ROLE = '00000000-0000-0000-0000-0000000000c3'
const state = vi.hoisted(() => ({ role: 'owner' as string, perms: null as Set<string> | null }))
const svc = vi.hoisted(() => ({
  listRoles: vi.fn(),
  createCustomRole: vi.fn(),
  updateCustomRole: vi.fn(),
  deleteCustomRole: vi.fn(),
  assignMemberRole: vi.fn(),
  memberHasCustomRole: vi.fn(),
  roleKind: vi.fn(),
  setSystemRolePermissions: vi.fn(),
  resetSystemRolePermissions: vi.fn(),
}))
const rpc = vi.hoisted(() => vi.fn(async () => ({ error: null })))

vi.mock('@/lib/auth/account', () => ({
  requirePermission: async (p: Permission) => {
    const subject = { role: state.role as AccountRole, ...(state.perms ? { permissions: state.perms } : {}) }
    if (!can(subject, p)) throw Object.assign(new Error('Sem permissão'), { status: 403 })
    return { accountId: 'acc', userId: '00000000-0000-0000-0000-0000000000a1', ...subject, supabase: { rpc } }
  },
  toErrorResponse: (err: { status?: number; message?: string }) => NextResponse.json({ error: err.message }, { status: err.status ?? 500 }),
}))
vi.mock('@/lib/account/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitResponse: () => NextResponse.json({}, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/roles/custom-roles', async (orig) => ({ ...(await orig<object>()), ...svc }))

const roles = await import('./route')
const one = await import('./[roleId]/route')
const assign = await import('../members/[userId]/role/route')
const reset = await import('./[roleId]/reset/route')
const member = await import('../members/[userId]/route')
const { CustomRoleError } = await import('@/lib/roles/custom-roles')

const req = (method: string, body?: unknown) => new Request('http://x', { method, body: body === undefined ? undefined : JSON.stringify(body) })
const roleParams = (roleId: string) => ({ params: Promise.resolve({ roleId }) })
const userParams = (userId: string) => ({ params: Promise.resolve({ userId }) })

beforeEach(() => {
  state.role = 'owner'
  state.perms = null
  for (const fn of Object.values(svc)) fn.mockReset()
  svc.roleKind.mockResolvedValue('custom')
  rpc.mockClear()
})

describe('GET/POST /api/account/roles', () => {
  it('GET: qualquer membro (members.view) lista', async () => {
    svc.listRoles.mockResolvedValue({ roles: [], limits: { max_custom_roles: 20, custom_roles: 0 } })
    for (const role of ['viewer', 'agent', 'owner']) {
      state.role = role
      expect((await roles.GET()).status).toBe(200)
    }
    expect(svc.listRoles).toHaveBeenCalledWith({}, 'acc', expect.objectContaining({ role: 'owner' }))
  })

  it('POST: admin e acima (TASK5); 201 com o papel criado', async () => {
    svc.createCustomRole.mockResolvedValue({ id: ROLE, key: 'custom_x', compat_role: 'agent' })
    const res = await roles.POST(req('POST', { name: 'Cobrança', permissions: ['inbox.view'] }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, id: ROLE, key: 'custom_x', compat_role: 'agent' })
    expect(svc.createCustomRole).toHaveBeenCalledWith({}, { accountId: 'acc', actorId: ME, name: 'Cobrança', permissions: ['inbox.view'] })
    state.role = 'admin'
    expect((await roles.POST(req('POST', { name: 'X', permissions: ['inbox.view'] }))).status).toBe(201)
    for (const role of ['supervisor', 'agent', 'viewer']) {
      state.role = role
      expect((await roles.POST(req('POST', { name: 'X', permissions: ['inbox.view'] }))).status).toBe(403)
    }
  })

  it('POST: corpo inválido → 400 com a lista, sem ir ao banco', async () => {
    const res = await roles.POST(req('POST', { name: 'X', permissions: ['inbox.reply'] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_permissions', errors: [{ code: 'missing_dependency', permission: 'inbox.reply', requires: 'inbox.view' }] })
    expect((await roles.POST(req('POST', null))).status).toBe(400)
    expect(svc.createCustomRole).not.toHaveBeenCalled()
  })

  it('erros do serviço viram o status e o code dele', async () => {
    svc.createCustomRole.mockRejectedValue(new CustomRoleError('Limite atingido', 409, 'limit_reached'))
    const res = await roles.POST(req('POST', { name: 'X', permissions: ['inbox.view'] }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Limite atingido', code: 'limit_reached' })
  })
})

describe('PATCH/DELETE /api/account/roles/[roleId]', () => {
  it('PATCH personalizado: admin e acima; repassa só o que veio', async () => {
    svc.updateCustomRole.mockResolvedValue({ id: ROLE, compat_role: 'supervisor', previous_compat_role: 'agent', members_updated: 2 })
    const res = await one.PATCH(req('PATCH', { permissions: ['inbox.view', 'reports.view_team'] }), roleParams(ROLE))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, members_updated: 2 })
    expect(svc.updateCustomRole).toHaveBeenCalledWith({}, { accountId: 'acc', actorId: ME, roleId: ROLE, permissions: ['inbox.view', 'reports.view_team'] })
    state.role = 'supervisor'
    expect((await one.PATCH(req('PATCH', { name: 'Y' }), roleParams(ROLE))).status).toBe(403)
  })

  it('PATCH cargo de sistema: só permissões (ajuste da organização); nome/descrição = 400; outra organização = 404', async () => {
    svc.roleKind.mockResolvedValue('system')
    svc.setSystemRolePermissions.mockResolvedValue({ id: ROLE, compat_role: 'supervisor', previous_compat_role: 'supervisor', members_updated: 0, customized: true })
    const res = await one.PATCH(req('PATCH', { permissions: ['inbox.view'] }), roleParams(ROLE))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, customized: true })
    expect(svc.setSystemRolePermissions).toHaveBeenCalledWith({}, { accountId: 'acc', actorId: ME, roleId: ROLE, permissions: ['inbox.view'] })
    expect((await one.PATCH(req('PATCH', { name: 'Novo' }), roleParams(ROLE))).status).toBe(400)
    expect(svc.updateCustomRole).not.toHaveBeenCalled()
    svc.roleKind.mockResolvedValue(null)
    expect((await one.PATCH(req('PATCH', { permissions: ['inbox.view'] }), roleParams(ROLE))).status).toBe(404)
  })

  it('erros de escalada e de nível chegam com o code', async () => {
    svc.roleKind.mockResolvedValue('system')
    svc.setSystemRolePermissions.mockRejectedValue(new CustomRoleError('Sem', 403, 'escalation', { permissions: ['campaigns.manage'] }))
    const res = await one.PATCH(req('PATCH', { permissions: ['inbox.view'] }), roleParams(ROLE))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sem', code: 'escalation', permissions: ['campaigns.manage'] })
  })

  it('POST reset: só cargo de sistema; admin e acima', async () => {
    svc.roleKind.mockResolvedValue('system')
    svc.resetSystemRolePermissions.mockResolvedValue({ id: ROLE, compat_role: 'agent', members_updated: 2, customized: false })
    const res = await reset.POST(req('POST'), roleParams(ROLE))
    expect(await res.json()).toMatchObject({ ok: true, customized: false, members_updated: 2 })
    svc.roleKind.mockResolvedValue('custom')
    expect((await reset.POST(req('POST'), roleParams(ROLE))).status).toBe(400)
    state.role = 'supervisor'
    expect((await reset.POST(req('POST'), roleParams(ROLE))).status).toBe(403)
  })

  it('id inválido → 404; corpo vazio → 400', async () => {
    expect((await one.PATCH(req('PATCH', { name: 'Y' }), roleParams('x'))).status).toBe(404)
    expect((await one.DELETE(req('DELETE'), roleParams('x'))).status).toBe(404)
    expect((await one.PATCH(req('PATCH', {}), roleParams(ROLE))).status).toBe(400)
  })

  it('DELETE em uso → 409 com a contagem', async () => {
    svc.deleteCustomRole.mockRejectedValue(new CustomRoleError('Em uso por 3', 409, 'role_in_use', { members: 3 }))
    const res = await one.DELETE(req('DELETE'), roleParams(ROLE))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Em uso por 3', code: 'role_in_use', members: 3 })
  })
})

describe('PUT /api/account/members/[userId]/role', () => {
  it('admin e acima atribuem; nunca a si mesmo; role_id obrigatório; supervisor não', async () => {
    svc.assignMemberRole.mockResolvedValue({ previous_role_id: null, role_id: ROLE, compat_role: 'agent' })
    const res = await assign.PUT(req('PUT', { role_id: ROLE }), userParams(OTHER))
    expect(res.status).toBe(200)
    expect(svc.assignMemberRole).toHaveBeenCalledWith({}, { accountId: 'acc', actorId: ME, targetId: OTHER, roleId: ROLE })
    expect((await assign.PUT(req('PUT', { role_id: ROLE }), userParams(ME))).status).toBe(403)
    expect((await assign.PUT(req('PUT', { role_id: 'x' }), userParams(OTHER))).status).toBe(400)
    expect((await assign.PUT(req('PUT', { role_id: ROLE }), userParams('x'))).status).toBe(404)
    state.role = 'admin'
    expect((await assign.PUT(req('PUT', { role_id: ROLE }), userParams(OTHER))).status).toBe(200)
    state.role = 'supervisor'
    expect((await assign.PUT(req('PUT', { role_id: ROLE }), userParams(OTHER))).status).toBe(403)
  })
})

describe('PATCH /api/account/members/[userId] (troca de papel de sistema, admin)', () => {
  it('quem gere membros sem roles.manage não tira ninguém de papel personalizado; com roles.manage (admin, proprietário) pode', async () => {
    // personalizado com members.manage, sem roles.manage
    state.role = 'admin'
    state.perms = new Set(['members.view', 'members.manage'])
    svc.memberHasCustomRole.mockResolvedValue(true)
    const res = await member.PATCH(req('PATCH', { role: 'agent' }), userParams(OTHER))
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()

    svc.memberHasCustomRole.mockResolvedValue(false)
    expect((await member.PATCH(req('PATCH', { role: 'agent' }), userParams(OTHER))).status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('set_member_role', { p_user_id: OTHER, p_new_role: 'agent' })

    state.perms = null // admin de sistema: tem roles.manage (TASK5)
    rpc.mockClear()
    svc.memberHasCustomRole.mockResolvedValue(true)
    expect((await member.PATCH(req('PATCH', { role: 'supervisor' }), userParams(OTHER))).status).toBe(200)
    expect(svc.memberHasCustomRole).toHaveBeenCalledTimes(2) // com roles.manage nem consulta
  })
})
