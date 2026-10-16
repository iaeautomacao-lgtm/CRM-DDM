// PATCH /api/account/members/[userId] com mention_alias (migration 376, @operador): permissão members.manage, formato,
// só operador (role agent), duplicado → 409 e a escrita sempre escopada pela conta do chamador.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { can, type Permission } from '@/lib/auth/permissions'
import type { AccountRole } from '@/lib/auth/roles'

const TARGET = '00000000-0000-0000-0000-0000000000b2'
const state = vi.hoisted(() => ({
  role: 'admin' as string,
  targetRole: 'agent' as string | null,
  updateError: null as { code: string } | null,
  updates: [] as Array<{ patch: unknown; filters: Record<string, string> }>,
  rpc: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requirePermission: async (p: Permission) => {
    if (!can({ role: state.role as AccountRole }, p)) throw Object.assign(new Error('Sem permissão'), { status: 403 })
    return { accountId: 'acc', userId: 'me', role: state.role, supabase: { rpc: state.rpc } }
  },
  toErrorResponse: (err: { status?: number; message?: string }) => NextResponse.json({ error: err.message }, { status: err.status ?? 500 }),
}))
vi.mock('@/lib/account/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => {
        const chain = { eq: () => chain, limit: async () => ({ data: state.targetRole ? [{ account_role: state.targetRole }] : [], error: null }) }
        return chain
      },
      update: (patch: unknown) => {
        const filters: Record<string, string> = {}
        const chain = {
          eq: (k: string, v: string) => {
            filters[k] = v
            if (Object.keys(filters).length === 2) {
              state.updates.push({ patch, filters })
              return Promise.resolve({ error: state.updateError })
            }
            return chain
          },
        }
        return chain
      },
    }),
  }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitResponse: () => NextResponse.json({}, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/roles/custom-roles', () => ({ memberHasCustomRole: async () => false }))

const { PATCH } = await import('./route')
const patch = (body: unknown) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ userId: TARGET }) })

beforeEach(() => {
  state.role = 'admin'
  state.targetRole = 'agent'
  state.updateError = null
  state.updates = []
  state.rpc.mockReset()
  state.rpc.mockResolvedValue({ error: null })
})

describe('PATCH members/[userId] — mention_alias', () => {
  it('admin grava o apelido do operador, escopado por conta e usuário', async () => {
    const res = await patch({ mention_alias: 'adriana' })
    expect(res.status).toBe(200)
    expect(state.updates).toEqual([{ patch: { mention_alias: 'adriana' }, filters: { account_id: 'acc', user_id: TARGET } }])
  })

  it('null apaga o apelido', async () => {
    expect((await patch({ mention_alias: null })).status).toBe(200)
    expect(state.updates[0].patch).toEqual({ mention_alias: null })
  })

  it('sem members.manage (supervisor) → 403, nada gravado', async () => {
    state.role = 'supervisor'
    expect((await patch({ mention_alias: 'adriana' })).status).toBe(403)
    expect(state.updates).toHaveLength(0)
  })

  it('formato inválido → 400 (maiúscula, @, curto, longo, número, tipo errado), sem normalizar no servidor', async () => {
    for (const bad of ['Adriana', '@adriana', 'a', 'x'.repeat(33), '1abc', 'ab-c', 42, '']) {
      const res = await patch({ mention_alias: bad })
      expect(res.status, String(bad)).toBe(400)
    }
    expect(state.updates).toHaveLength(0)
  })

  it('alvo que não é operador (ou de outra conta) → 400', async () => {
    state.targetRole = 'admin'
    expect((await patch({ mention_alias: 'chefe' })).status).toBe(400)
    state.targetRole = null
    expect((await patch({ mention_alias: 'chefe' })).status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })

  it('apelido já usado na conta → 409; migration 376 ausente → 503', async () => {
    state.updateError = { code: '23505' }
    const dup = await patch({ mention_alias: 'adriana' })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'Alias já está em uso nesta conta' })
    state.updateError = { code: '42703' }
    expect((await patch({ mention_alias: 'adriana' })).status).toBe(503)
  })

  it('o apelido vem junto com o limite de chats no mesmo PATCH; sem nenhum campo → 400', async () => {
    expect((await patch({ mention_alias: 'adriana', max_simultaneous_chats: 3 })).status).toBe(200)
    expect(state.rpc).toHaveBeenCalledWith('set_member_max_simultaneous_chats', { p_user_id: TARGET, p_max: 3 })
    expect((await patch({})).status).toBe(400)
  })

  it('apelido inválido não deixa o limite de chats gravado pela metade', async () => {
    expect((await patch({ mention_alias: 'Ruim', max_simultaneous_chats: 3 })).status).toBe(400)
    expect(state.rpc).not.toHaveBeenCalled()
  })
})
