// /api/automations/cron com a migration 317: claim por RPC (uma linha por vez, com lease), conta as fechadas pelo
// reaper, para quando não há mais nada, cai no caminho antigo sem a 317 e não devolve erro do banco.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  claims: [] as Array<{ data: unknown; error: { code?: string; message: string } | null }>,
  rpcCalls: [] as unknown[][],
  resumed: [] as string[],
  legacyRows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/audit/context', () => ({ registerAuditActor: async () => undefined }))
vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: vi.fn(async (p: { id: string }) => {
    state.resumed.push(p.id)
  }),
}))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (name: string, args: unknown) => {
      state.rpcCalls.push([name, args])
      return state.claims.shift() ?? { data: [{ claimed: null, reaped: 0 }], error: null }
    },
    from: () => {
      let isUpdate = false
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'lte', 'order', 'limit']) b[op] = () => b
      b.update = () => ((isUpdate = true), b)
      b.maybeSingle = () => Promise.resolve({ data: { id: 'x' }, error: null })
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve(isUpdate ? { data: null, error: null } : { data: state.legacyRows, error: null }).then(ok)
      return b
    },
  }),
}))

const { POST } = await import('./route')
const call = () => POST(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 's3cr3t' } }))
const claimed = (id: string, reaped = 0) => ({ data: [{ claimed: { id, automation_id: 'a', account_id: 'acc', user_id: 'u', next_step_position: 1 }, reaped }], error: null })

beforeEach(() => {
  vi.stubEnv('AUTOMATION_CRON_SECRET', 's3cr3t')
  state.claims = []
  state.rpcCalls = []
  state.resumed = []
  state.legacyRows = []
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('POST /api/automations/cron (lease, migration 317)', () => {
  it('reivindica uma por vez pela RPC com lease de 300 s até acabar; soma as fechadas pelo reaper', async () => {
    state.claims = [claimed('p1', 2), claimed('p2'), { data: [{ claimed: null, reaped: 0 }], error: null }]
    const res = await call()
    expect(await res.json()).toEqual({ processed: 2, reaped: 2 })
    expect(state.resumed).toEqual(['p1', 'p2'])
    expect(state.rpcCalls[0]).toEqual(['claim_automation_pending', { p_lease_seconds: 300 }])
    expect(state.rpcCalls).toHaveLength(3)
  })

  it('para em 50 por chamada', async () => {
    state.claims = Array.from({ length: 60 }, (_, i) => claimed(`p${i}`))
    expect(await (await call()).json()).toMatchObject({ processed: 50 })
  })

  it('banco sem a 317: caminho antigo (claim em dois passos)', async () => {
    state.claims = [{ data: null, error: { code: 'PGRST202', message: 'not found' } }]
    state.legacyRows = [{ id: 'old1', automation_id: 'a', account_id: 'acc', user_id: 'u', next_step_position: 0 }]
    expect(await (await call()).json()).toEqual({ processed: 1 })
    expect(state.resumed).toEqual(['old1'])
  })

  it('outro erro do banco: 500 sem o detalhe; sem segredo: 401', async () => {
    state.claims = [{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout on wacrm.x' } }]
    const res = await call()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('wacrm')
    expect((await POST(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 'nope' } }))).status).toBe(401)
  })
})
