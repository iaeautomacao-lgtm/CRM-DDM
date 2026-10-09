import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const CONV = 'c0000000-0000-0000-0000-000000000001'
const ME = 'u-me'
const OTHER = 'u-other'
const tables: Record<string, Row[]> = {}
let denied = false
let visibleToUser = true
let raceStealer: string | null = null // simula outro atendente assumindo entre a leitura e o UPDATE

vi.mock('@/lib/auth/account', () => ({
  requirePermission: async (perm: string) => {
    if (denied) throw Object.assign(new Error('forbidden'), { status: 403, perm })
    return { accountId: 'acc-1', userId: ME, supabase: { from: (t: string) => builder(t, 'user') } }
  },
  toErrorResponse: (e: { status?: number; message?: string }) => new Response(JSON.stringify({ error: e.message }), { status: e.status ?? 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t, 'admin') }) }))

function builder(table: string, who: 'user' | 'admin') {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'update' = 'select'
  let patch: Row = {}
  const b: Record<string, unknown> = {}
  b.select = () => b
  b.order = () => b
  b.limit = () => b
  b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
  b.is = (c: string, v: unknown) => (filters.push((r) => (v === null ? r[c] == null : r[c] === v)), b)
  b.neq = (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b)
  b.gte = () => b
  b.update = (p: Row) => ((op = 'update'), (patch = p), b)
  b.then = (resolve: (v: unknown) => void) => {
    const rows = (tables[table] ??= [])
    if (table === 'conversations' && who === 'user' && !visibleToUser) return resolve({ data: [], error: null })
    if (op === 'update') {
      if (table === 'conversations' && raceStealer) {
        // outro atendente venceu a corrida antes do nosso UPDATE condicional
        rows.forEach((r) => { r.assigned_agent_id = raceStealer })
        raceStealer = null
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      hit.forEach((r) => Object.assign(r, patch))
      return resolve({ data: hit, error: null })
    }
    return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null })
  }
  return b
}

import { POST } from './route'

const call = (id = CONV) => POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.conversations = [{ id: CONV, account_id: 'acc-1', status: 'open', assigned_agent_id: null, team_id: 'team-1' }]
  tables.conversation_assignments = [{ id: 'a1', conversation_id: CONV, actor_id: null, created_at: new Date(Date.now() + 1000).toISOString() }]
  denied = false
  visibleToUser = true
  raceStealer = null
})

describe('POST /api/conversations/[id]/assign-self', () => {
  it('assume a conversa sem atendente: grava o atendente e completa o ator no histórico', async () => {
    const r = await call()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ already_mine: false, conversation: { id: CONV, assigned_agent_id: ME, team_id: 'team-1' } })
    expect(tables.conversations[0].assigned_agent_id).toBe(ME)
    expect(tables.conversation_assignments[0]).toMatchObject({ actor_id: ME, reason: 'Assumiu a conversa' })
  })

  it('idempotente: assumir a que já é sua = 200 já minha, sem tocar em nada', async () => {
    tables.conversations[0].assigned_agent_id = ME
    const r = await call()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ already_mine: true })
    expect(tables.conversation_assignments[0].actor_id).toBeNull()
  })

  it('conversa de OUTRO atendente = 409 already_assigned e nada muda (transferir é outra rota)', async () => {
    tables.conversations[0].assigned_agent_id = OTHER
    const r = await call()
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: 'already_assigned' })
    expect(tables.conversations[0].assigned_agent_id).toBe(OTHER)
  })

  it('conversa encerrada = 409 conversation_closed', async () => {
    tables.conversations[0].status = 'closed'
    const r = await call()
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: 'conversation_closed' })
    expect(tables.conversations[0].assigned_agent_id).toBeNull()
  })

  it('ATÔMICO: se outro atendente assumir entre a leitura e o UPDATE, o UPDATE condicional não sobrescreve e responde 409', async () => {
    raceStealer = OTHER
    const r = await call()
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: 'already_assigned' })
    expect(tables.conversations[0].assigned_agent_id).toBe(OTHER)
  })

  it('conversa que o usuário não enxerga (RLS: outra equipe/conta) = 404; id inválido = 400; sem permissão = 403', async () => {
    visibleToUser = false
    expect((await call()).status).toBe(404)
    expect(tables.conversations[0].assigned_agent_id).toBeNull()
    visibleToUser = true
    expect((await call('nao-e-uuid')).status).toBe(400)
    denied = true
    expect((await call()).status).toBe(403)
    expect(tables.conversations[0].assigned_agent_id).toBeNull()
  })
})
