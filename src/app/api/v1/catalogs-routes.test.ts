import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/v1/tabulations | /agents | /teams — escopos, isolamento por conta, status de presença, pausa, filtros, cursor e SEM dado sensível.

type Row = Record<string, any>
const A = 'ACC-A'
const B = 'ACC-B'
const NOW = Date.now()
const iso = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString()

const h = vi.hoisted(() => ({ scopes: ['conversations:read'] as string[], rate: true, db: {} as Record<string, Row[]> }))

class Q {
  filters: Array<(r: Row) => boolean> = []
  orders: Array<[string, boolean]> = []
  lim = Infinity
  constructor(private table: string) {}
  select() { return this }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
  or(expr: string) {
    const m = expr.match(/^created_at\.gt\.(.+?),and\(created_at\.eq\.(.+?),user_id\.gt\.(.+)\)$/)
    if (!m) throw new Error(`or não suportado: ${expr}`)
    this.filters.push((r) => r.created_at > m[1] || (r.created_at === m[1] && r.user_id > m[3]))
    return this
  }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push([c, o?.ascending !== false]); return this }
  limit(n: number) { this.lim = n; return this }
  then(resolve: (v: unknown) => void) {
    let rows = (h.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)))
    for (const [c, asc] of [...this.orders].reverse()) rows = [...rows].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] ?? '') > (b[c] ?? '') ? (asc ? 1 : -1) : asc ? -1 : 1))
    resolve({ data: rows.slice(0, this.lim), error: null })
  }
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async (_r: Request, scope: string[]) => {
    if (!scope.some((s) => h.scopes.includes(s))) {
      const { forbidden } = await import('@/lib/api/v1/respond')
      throw forbidden('sem escopo')
    }
    return { accountId: A, keyId: 'KEY', scopes: h.scopes, supabase: { from: (t: string) => new Q(t) } }
  },
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: async () => ({ success: h.rate, limit: 60, remaining: 0, reset: Date.now() + 30_000 }),
}))

const tabulations = await import('./tabulations/route')
const agents = await import('./agents/route')
const teams = await import('./teams/route')

const get = (h2: (r: Request) => Promise<Response>, path: string) => h2(new Request(`http://localhost/api/v1${path}`))
const json = async (r: Response) => (await r.json()) as any

beforeEach(() => {
  h.scopes = ['conversations:read']
  h.rate = true
  h.db = {
    tags: [
      { id: 't1', account_id: A, name: 'Acordo Realizado', color: '#16a34a', kind: 'outcome', codigo_tabulacao: 142 },
      { id: 't2', account_id: A, name: 'Sem interesse', color: null, kind: 'outcome', codigo_tabulacao: 7 },
      { id: 't3', account_id: A, name: 'Inadimplente', color: '#f00', kind: 'contact', codigo_tabulacao: null }, // etiqueta de contato: fora
      { id: 't4', account_id: B, name: 'Da outra conta', color: null, kind: 'outcome', codigo_tabulacao: 1 },
    ],
    teams: [
      { id: 'e1', account_id: A, name: 'Cobrança', overflow_team_id: 'e2' },
      { id: 'e2', account_id: A, name: 'Retaguarda', overflow_team_id: null },
      { id: 'e9', account_id: B, name: 'Outra conta', overflow_team_id: null },
    ],
    team_members: [
      { team_id: 'e1', user_id: 'u1' }, { team_id: 'e1', user_id: 'u2' }, { team_id: 'e2', user_id: 'u3' }, { team_id: 'e9', user_id: 'x1' },
    ],
    profiles: [
      { user_id: 'u1', account_id: A, full_name: 'Ana', account_role: 'agent', created_at: '2026-01-01T00:00:00+00:00', max_simultaneous_chats: 8, deactivated_at: null, email: 'ana@x.com' },
      { user_id: 'u2', account_id: A, full_name: 'Beto', account_role: 'supervisor', created_at: '2026-01-02T00:00:00+00:00', max_simultaneous_chats: null, deactivated_at: null },
      { user_id: 'u3', account_id: A, full_name: null, account_role: 'agent', created_at: '2026-01-03T00:00:00+00:00', max_simultaneous_chats: null, deactivated_at: null },
      { user_id: 'u4', account_id: A, full_name: 'Visitante', account_role: 'viewer', created_at: '2026-01-04T00:00:00+00:00', max_simultaneous_chats: null, deactivated_at: null },
      { user_id: 'u5', account_id: A, full_name: 'Desativada', account_role: 'agent', created_at: '2026-01-05T00:00:00+00:00', max_simultaneous_chats: null, deactivated_at: '2026-02-01T00:00:00Z' },
      { user_id: 'x1', account_id: B, full_name: 'De outra conta', account_role: 'agent', created_at: '2026-01-06T00:00:00+00:00', max_simultaneous_chats: null, deactivated_at: null },
    ],
    member_presence: [
      { user_id: 'u1', status: 'online', last_seen_at: iso(10) },
      { user_id: 'u2', status: 'away', last_seen_at: iso(20) },
      { user_id: 'u3', status: 'online', last_seen_at: iso(300) }, // 5 min: offline
    ],
    agent_pauses: [{ user_id: 'u1', account_id: A, reason_name: 'Almoço', started_at: iso(600), ended_at: null }],
  }
})

describe('GET /tabulations', () => {
  it('só as tabulações (outcome) da conta, por código; sem etiqueta de contato nem de outra conta', async () => {
    const res = await get(tabulations.GET, '/tabulations')
    expect(res.status).toBe(200)
    expect((await json(res)).data.items).toEqual([
      { id: 't2', code: 7, name: 'Sem interesse', color: null },
      { id: 't1', code: 142, name: 'Acordo Realizado', color: '#16a34a' },
    ])
  })
  it('aceita conversations:write; outro escopo = 403; limite = 429', async () => {
    h.scopes = ['conversations:write']
    expect((await get(tabulations.GET, '/tabulations')).status).toBe(200)
    h.scopes = ['messages:send']
    expect((await get(tabulations.GET, '/tabulations')).status).toBe(403)
    h.scopes = ['conversations:read']
    h.rate = false
    const limited = await get(tabulations.GET, '/tabulations')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBeTruthy()
  })
})

describe('GET /teams', () => {
  it('equipes da conta com transbordo e membros (nunca de outra conta)', async () => {
    const items = (await json(await get(teams.GET, '/teams'))).data.items
    expect(items).toEqual([
      { id: 'e1', name: 'Cobrança', overflow_team_id: 'e2', member_ids: ['u1', 'u2'] },
      { id: 'e2', name: 'Retaguarda', overflow_team_id: null, member_ids: ['u3'] },
    ])
  })
})

describe('GET /agents', () => {
  it('ativos da conta (sem visualizador, desativado ou de outra conta), com status, pausa e equipes; SEM e-mail', async () => {
    const res = await get(agents.GET, '/agents')
    expect(res.status).toBe(200)
    const { items, next_cursor } = (await json(res)).data
    expect(next_cursor).toBeNull()
    expect(items).toEqual([
      { id: 'u1', name: 'Ana', role: 'agent', team_ids: ['e1'], status: 'online', paused: true, pause: { reason: 'Almoço', since: expect.any(String) }, max_simultaneous_chats: 8 },
      { id: 'u2', name: 'Beto', role: 'supervisor', team_ids: ['e1'], status: 'away', paused: false, pause: null, max_simultaneous_chats: null },
      { id: 'u3', name: 'Atendente', role: 'agent', team_ids: ['e2'], status: 'offline', paused: false, pause: null, max_simultaneous_chats: null },
    ])
    expect(JSON.stringify(items)).not.toMatch(/email|ana@x|phone|telefone/)
  })

  it('filtros: team_id, role e status', async () => {
    const ids = async (qs: string) => (await json(await get(agents.GET, `/agents${qs}`))).data.items.map((i: any) => i.id)
    expect(await ids('?team_id=11111111-1111-4111-8111-111111111111')).toEqual([])
    h.db.team_members.push({ team_id: '11111111-1111-4111-8111-111111111111', user_id: 'u3' })
    expect(await ids('?team_id=11111111-1111-4111-8111-111111111111')).toEqual(['u3'])
    expect(await ids('?role=supervisor')).toEqual(['u2'])
    expect(await ids('?status=online')).toEqual(['u1'])
    expect(await ids('?status=offline')).toEqual(['u3'])
  })

  it('paginação por cursor sem repetir nem pular', async () => {
    const first = (await json(await get(agents.GET, '/agents?limit=2'))).data
    expect(first.items.map((i: any) => i.id)).toEqual(['u1', 'u2'])
    expect(first.next_cursor).toBeTruthy()
    const second = (await json(await get(agents.GET, `/agents?limit=2&cursor=${first.next_cursor}`))).data
    expect(second.items.map((i: any) => i.id)).toEqual(['u3'])
    expect(second.next_cursor).toBeNull()
  })

  it('entradas inválidas = 400; sem escopo = 403', async () => {
    for (const qs of ['?team_id=x', '?role=viewer', '?status=ocupado', '?limit=0', '?cursor=lixo']) {
      expect((await get(agents.GET, `/agents${qs}`)).status, qs).toBe(400)
    }
    h.scopes = ['contacts:read']
    expect((await get(agents.GET, '/agents')).status).toBe(403)
  })
})
