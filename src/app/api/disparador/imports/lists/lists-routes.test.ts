// PRD 24, item 8: GET /imports/lists, PATCH /imports/[id] (nome) e POST /imports/[id]/reuse, com Supabase em memória.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const ACC = 'a0000000-0000-0000-0000-000000000001'
const J1 = 'f0000000-0000-0000-0000-000000000001'
const J2 = 'f0000000-0000-0000-0000-000000000002'
const J3 = 'f0000000-0000-0000-0000-000000000003'
const JX = 'f0000000-0000-0000-0000-0000000000ff'
const tables: Record<string, Row[]> = {}
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = { data: { contacts: 3, variables: 2 }, error: null }
let missingNameColumn = false
let denied = false

vi.mock('@/lib/disparador/route-auth', () => ({
  requireDisparadorAccess: async () => {
    if (denied) throw Object.assign(new Error('forbidden'), { status: 403 })
    return { accountId: ACC, userId: 'u1' }
  },
}))
vi.mock('@/lib/auth/account', () => ({
  toErrorResponse: (e: { status?: number; message?: string }) => new Response(JSON.stringify({ error: e.message }), { status: e.status ?? 500 }),
}))
vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => (rpcCalls.push({ fn, args }), rpcResult),
    from: (t: string) => builder(t),
  }),
}))

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'update' = 'select'
  let patch: Row = {}
  let lim = 1000
  let orFilter: string | null = null
  const sortKeys: Array<[string, boolean]> = []
  const b: Record<string, unknown> = {}
  b.select = () => b
  b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
  b.ilike = (c: string, pattern: string) => {
    const needle = pattern.replace(/%/g, '').toLowerCase()
    filters.push((r) => String(r[c] ?? '').toLowerCase().includes(needle))
    return b
  }
  b.or = (expr: string) => ((orFilter = expr), b)
  b.order = (c: string, o: { ascending: boolean }) => (sortKeys.push([c, o.ascending]), b)
  b.limit = (n: number) => ((lim = n), b)
  b.update = (p: Row) => ((op = 'update'), (patch = p), b)
  b.maybeSingle = () => Promise.resolve(run(true))
  b.then = (resolve: (v: unknown) => void) => resolve(run(false))
  function run(single: boolean) {
    let rows = (tables[table] ??= []).filter((r) => filters.every((f) => f(r)))
    if (orFilter) {
      const m = /created_at\.lt\.(.+?),and\(created_at\.eq\.(.+?),id\.lt\.(.+?)\)/.exec(orFilter)
      if (m) rows = rows.filter((r) => String(r.created_at) < m[1] || (String(r.created_at) === m[2] && String(r.id) < m[3]))
    }
    for (const [k, asc] of [...sortKeys].reverse()) rows = [...rows].sort((a, c) => (String(a[k]) < String(c[k]) ? -1 : 1) * (asc ? 1 : -1))
    if (op === 'update') {
      if (missingNameColumn && 'name' in patch) return { data: null, error: { code: '42703', message: 'column "name" does not exist' } }
      rows.forEach((r) => Object.assign(r, patch))
    }
    rows = rows.slice(0, lim)
    return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }
  }
  return b
}

const job = (id: string, over: Row = {}): Row => ({
  id, account_id: ACC, state: 'done', name: null, draft_id: `draft-${id}`, campaign_id: null, rows_total: 10,
  totals: { importados: 8, duplicados: 1, invalidos: 1, blacklisted: 0, variaveis_falhas: 0 }, linked: 9,
  blocks: {}, errors: [], created_at: '2026-10-09T10:00:00Z', finished_at: '2026-10-09T10:05:00Z', ...over,
})

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.dispatch_import_jobs = [
    job(J1, { name: 'Inadimplentes 2024', created_at: '2026-10-09T10:00:00Z' }),
    job(J2, { name: 'Boletos vencidos', created_at: '2026-10-09T11:00:00Z' }),
    job(J3, { name: null, created_at: '2026-10-09T12:00:00Z' }),
    job('f0000000-0000-0000-0000-0000000000aa', { state: 'running' }),
    job('f0000000-0000-0000-0000-0000000000bb', { account_id: 'outra-conta', name: 'Alheia' }),
  ]
  rpcCalls.length = 0
  rpcResult = { data: { contacts: 3, variables: 2 }, error: null }
  missingNameColumn = false
  denied = false
})

describe('GET /api/disparador/imports/lists', () => {
  it('lista só as importações CONCLUÍDAS da conta, mais recentes primeiro, com nome e contagens do próprio job (sem linhas/erros)', async () => {
    const { GET } = await import('./route')
    const r = await GET(new Request('http://x/api/disparador/imports/lists'))
    const j = await r.json()
    expect(j.lists.map((l: { id: string }) => l.id)).toEqual([J3, J2, J1])
    expect(j.lists[1]).toEqual({
      id: J2, name: 'Boletos vencidos', state: 'done', created_at: '2026-10-09T11:00:00Z', finished_at: '2026-10-09T10:05:00Z',
      rows_total: 10, totals: { importados: 8, duplicados: 1, invalidos: 1, blacklisted: 0, variaveis_falhas: 0 }, linked: 9, source: 'draft',
    })
    expect(j.lists[0].name).toBeNull()
    expect(JSON.stringify(j)).not.toContain('Alheia')
    expect(j.next_cursor).toBeNull()
  })

  it('busca por nome (q) e paginação por cursor', async () => {
    const { GET } = await import('./route')
    const q = await (await GET(new Request('http://x/api/disparador/imports/lists?q=boletos'))).json()
    expect(q.lists.map((l: { id: string }) => l.id)).toEqual([J2])
    const p1 = await (await GET(new Request('http://x/api/disparador/imports/lists?limit=2'))).json()
    expect(p1.lists.map((l: { id: string }) => l.id)).toEqual([J3, J2])
    expect(p1.next_cursor).toBe(`2026-10-09T11:00:00Z|${J2}`)
    const p2 = await (await GET(new Request(`http://x/api/disparador/imports/lists?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`))).json()
    expect(p2.lists.map((l: { id: string }) => l.id)).toEqual([J1])
    expect(p2.next_cursor).toBeNull()
  })

  it('sem permissão: 403', async () => {
    denied = true
    const { GET } = await import('./route')
    expect((await GET(new Request('http://x/api/disparador/imports/lists'))).status).toBe(403)
  })
})

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const patch = (body: unknown) => new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })

describe('PATCH /api/disparador/imports/[id] (nome da lista)', () => {
  it('renomeia (aparando espaços) e remove o nome com null/""; só da própria conta', async () => {
    const { PATCH } = await import('../[id]/route')
    const r = await PATCH(patch({ name: '  Lista   de   Teste  ' }), ctx(J1))
    expect(r.status).toBe(200)
    expect((await r.json()).job.name).toBe('Lista de Teste')
    expect(tables.dispatch_import_jobs[0].name).toBe('Lista de Teste')
    await PATCH(patch({ name: null }), ctx(J1))
    expect(tables.dispatch_import_jobs[0].name).toBeNull()
    expect((await PATCH(patch({ name: 'x' }), ctx('f0000000-0000-0000-0000-0000000000bb'))).status).toBe(404)
    expect(tables.dispatch_import_jobs[4].name).toBe('Alheia')
  })

  it('valida: nome grande demais/tipo errado = 400; corpo sem name = 400; id inválido = 404; sem a migration 292 = 503', async () => {
    const { PATCH } = await import('../[id]/route')
    expect((await PATCH(patch({ name: 'x'.repeat(121) }), ctx(J1))).status).toBe(400)
    expect((await PATCH(patch({ name: 5 }), ctx(J1))).status).toBe(400)
    expect((await PATCH(patch({}), ctx(J1))).status).toBe(400)
    expect((await PATCH(patch({ name: 'x' }), ctx('nao-e-uuid'))).status).toBe(404)
    missingNameColumn = true
    const r = await PATCH(patch({ name: 'x' }), ctx(J1))
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ code: 'unavailable' })
  })
})

describe('POST /api/disparador/imports/[id]/reuse', () => {
  const post = (id: string) => import('../[id]/reuse/route').then(({ POST }) => POST(new Request('http://x', { method: 'POST' }), ctx(id)))

  it('copia a lista para um rascunho NOVO (uuid) e devolve draft_id e contagens; a origem vai ao RPC com a conta do job', async () => {
    const r = await post(J1)
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j).toMatchObject({ contacts: 3, variables: 2 })
    expect(j.draft_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(j.draft_id).not.toBe(`draft-${J1}`)
    expect(rpcCalls[0]).toEqual({
      fn: 'duplicate_import_list',
      args: { p_account_id: ACC, p_source_draft: `draft-${J1}`, p_source_campaign: null, p_new_draft: j.draft_id },
    })
  })

  it('importação de edição de campanha: origem por campanha', async () => {
    tables.dispatch_import_jobs.push(job(JX, { draft_id: null, campaign_id: 'camp-9' }))
    await post(JX)
    expect(rpcCalls[0].args).toMatchObject({ p_source_draft: null, p_source_campaign: 'camp-9' })
  })

  it('não concluída = 409; sem vínculo = 409; de outra conta/inexistente = 404; sem a migration = 503; nada disso chama o RPC indevidamente', async () => {
    expect((await post('f0000000-0000-0000-0000-0000000000aa')).status).toBe(409)
    tables.dispatch_import_jobs.push(job(JX, { draft_id: null, campaign_id: null }))
    expect((await post(JX)).status).toBe(409)
    expect((await post('f0000000-0000-0000-0000-0000000000bb')).status).toBe(404)
    expect((await post('nao-e-uuid')).status).toBe(404)
    expect(rpcCalls).toHaveLength(0)
    rpcResult = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    const r = await post(J1)
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ code: 'unavailable' })
  })
})
