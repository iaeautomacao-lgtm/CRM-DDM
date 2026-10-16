import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  results: [] as Array<{ data: unknown; error: unknown }>,
  calls: [] as Array<{ columns: string; eq: Array<[string, unknown]>; in: Array<[string, unknown]> }>,
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: (columns: string) => {
        const call = { columns, eq: [] as Array<[string, unknown]>, in: [] as Array<[string, unknown]> }
        state.calls.push(call)
        const b: Record<string, unknown> = {}
        b.eq = (k: string, v: unknown) => (call.eq.push([k, v]), b)
        b.in = (k: string, v: unknown) => (call.in.push([k, v]), b)
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve(state.results.shift() ?? { data: [], error: null }).then(ok)
        return b
      },
    }),
  }),
}))

import { attachRequestedAgents, loadRequestedAgents } from './requested-agent'

const A = 'acc-1'
beforeEach(() => {
  state.results = []
  state.calls = []
})

describe('loadRequestedAgents', () => {
  it('só user_id, full_name e mention_alias, filtrado pela conta e sem repetir ids', async () => {
    state.results = [{ data: [{ user_id: 'u1', full_name: 'Ana', mention_alias: 'ana', email: 'x@y' }], error: null }]
    const m = await loadRequestedAgents(A, ['u1', 'u1', ''])
    expect(m.get('u1')).toEqual({ user_id: 'u1', full_name: 'Ana', mention_alias: 'ana' })
    expect(state.calls[0].columns).toBe('user_id, full_name, mention_alias')
    expect(state.calls[0].eq).toContainEqual(['account_id', A])
    expect(state.calls[0].in).toEqual([['user_id', ['u1']]])
  })

  it('sem ids não consulta o banco', async () => {
    expect((await loadRequestedAgents(A, [])).size).toBe(0)
    expect(state.calls).toHaveLength(0)
  })

  it('coluna mention_alias ausente (sem a 376): refaz sem ela e devolve alias null', async () => {
    state.results = [{ data: null, error: { code: '42703' } }, { data: [{ user_id: 'u1', full_name: 'Ana' }], error: null }]
    const m = await loadRequestedAgents(A, ['u1'])
    expect(state.calls.map((c) => c.columns)).toEqual(['user_id, full_name, mention_alias', 'user_id, full_name'])
    expect(m.get('u1')).toEqual({ user_id: 'u1', full_name: 'Ana', mention_alias: null })
  })

  it('outro erro: vazio, sem lançar', async () => {
    state.results = [{ data: null, error: { code: '57014' } }]
    expect((await loadRequestedAgents(A, ['u1'])).size).toBe(0)
  })
})

describe('attachRequestedAgents', () => {
  it('acrescenta requested_agent só nas reservadas; as demais ficam null e o contato não é tocado', async () => {
    state.results = [{ data: [{ user_id: 'u1', full_name: 'Ana', mention_alias: 'ana' }], error: null }]
    const rows = [
      { id: 'c1', requested_agent_id: 'u1', contact: { name: 'Cliente' } },
      { id: 'c2', requested_agent_id: null },
      { id: 'c3' },
    ]
    const out = await attachRequestedAgents(A, rows)
    expect(out[0]).toMatchObject({ id: 'c1', contact: { name: 'Cliente' }, requested_agent: { user_id: 'u1', full_name: 'Ana', mention_alias: 'ana' } })
    expect(out[1].requested_agent).toBeNull()
    expect(out[2].requested_agent).toBeNull()
    expect(state.calls).toHaveLength(1) // uma consulta só, para a página inteira
  })

  it('reservada a alguém sem perfil na conta: requested_agent null (o id continua na linha)', async () => {
    state.results = [{ data: [], error: null }]
    const [row] = await attachRequestedAgents(A, [{ id: 'c1', requested_agent_id: 'fantasma' }])
    expect(row.requested_agent_id).toBe('fantasma')
    expect(row.requested_agent).toBeNull()
  })

  it('lista sem nenhuma reserva não consulta perfis', async () => {
    await attachRequestedAgents(A, [{ id: 'c1' }, { id: 'c2', requested_agent_id: null }])
    expect(state.calls).toHaveLength(0)
  })
})
