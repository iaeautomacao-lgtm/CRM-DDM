// GET /api/conversations/[id]/reservation (migration 376): a RLS da sessão decide quem enxerga a conversa.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const ID = '11111111-1111-4111-8111-111111111111'
const state = vi.hoisted(() => ({
  conv: { data: [] as unknown[] | null, error: null as { code?: string; message?: string } | null },
  loaded: [] as unknown[][],
  agents: new Map<string, unknown>(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({
    accountId: 'acc',
    userId: 'me',
    supabase: {
      from: () => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) b[m] = () => b
        b.limit = async () => state.conv
        return b
      },
    },
  }),
  toErrorResponse: (e: { status?: number; message?: string }) => NextResponse.json({ error: e.message }, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/inbox/requested-agent', () => ({
  loadRequestedAgents: async (...args: unknown[]) => {
    state.loaded.push(args)
    return state.agents
  },
}))

const { GET } = await import('./route')
const get = (id = ID) => GET(new Request('http://x'), { params: Promise.resolve({ id }) })

beforeEach(() => {
  state.conv = { data: [], error: null }
  state.loaded = []
  state.agents = new Map()
})

describe('GET /api/conversations/[id]/reservation', () => {
  it('conversa reservada: devolve o id e só user_id/full_name/mention_alias do operador', async () => {
    state.conv = { data: [{ id: ID, requested_agent_id: 'u1' }], error: null }
    state.agents = new Map([['u1', { user_id: 'u1', full_name: 'Ana', mention_alias: 'ana' }]])
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ requested_agent_id: 'u1', requested_agent: { user_id: 'u1', full_name: 'Ana', mention_alias: 'ana' } })
    expect(state.loaded[0]).toEqual(['acc', ['u1']])
  })

  it('sem reserva: nulls e nenhuma consulta de perfil', async () => {
    state.conv = { data: [{ id: ID, requested_agent_id: null }], error: null }
    const res = await get()
    expect(await res.json()).toEqual({ requested_agent_id: null, requested_agent: null })
    expect(state.loaded).toHaveLength(0)
  })

  it('quem não pode ver a conversa (a RLS devolve vazio) ou id inválido: 404, sem vazar a reserva', async () => {
    expect((await get()).status).toBe(404)
    expect((await get('nao-e-uuid')).status).toBe(404)
    expect(state.loaded).toHaveLength(0)
  })

  it('sem a migration 376 (coluna ausente): "sem reserva", não erro', async () => {
    state.conv = { data: null, error: { code: '42703' } }
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ requested_agent_id: null, requested_agent: null })
  })

  it('outro erro do banco: 500', async () => {
    state.conv = { data: null, error: { code: '57014', message: 'timeout' } }
    expect((await get()).status).toBe(500)
  })
})
