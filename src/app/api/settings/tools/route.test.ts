import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasMinRole, type AccountRole } from '@/lib/auth/roles'

// ---------------------------------------------------------------------------
// /api/settings/tools: papéis, credencial literal → 400, liga/desliga, nome
// imutável, isolamento por conta, "usada em N fluxos" e a rota "Testar
// ferramenta" (só status + corpo sanitizado; nunca URL/headers resolvidos).
// ---------------------------------------------------------------------------

type Row = Record<string, any>
const state = vi.hoisted(() => ({
  role: 'admin' as string,
  accountId: 'ACC-1',
  rows: [] as Array<Record<string, any>>,
  seq: 0,
  usage: new Map<string, Set<string>>(),
  names: { credentials: [] as string[], variables: [] as string[] },
  account: { vars: new Map<string, string>(), creds: new Map<string, { value: string; hosts: string[] }>() },
  fetchCalls: [] as Array<{ url: string; init: any; options: any }>,
  fetchImpl: null as null | (() => Promise<Response>),
}))

function builder() {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let payload: any = null
  const b: any = {}
  b.select = () => b
  b.order = () => b
  b.limit = () => b
  b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
  b.insert = (p: any) => ((op = 'insert'), (payload = p), b)
  b.update = (p: any) => ((op = 'update'), (payload = p), b)
  b.delete = () => ((op = 'delete'), b)
  b.then = (resolve: (v: unknown) => unknown) => {
    const match = (r: Row) => filters.every((f) => f(r))
    if (op === 'insert') {
      if (state.rows.some((r) => r.account_id === payload.account_id && r.name === payload.name)) {
        return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve)
      }
      const row = {
        id: `00000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`,
        updated_at: '2026-10-08T10:00:00Z',
        created_at: '2026-10-08T10:00:00Z',
        ...payload,
      }
      state.rows.push(row)
      return Promise.resolve({ data: [row], error: null }).then(resolve)
    }
    if (op === 'update') {
      const hit = state.rows.filter(match)
      hit.forEach((r) => Object.assign(r, payload))
      return Promise.resolve({ data: hit, error: null }).then(resolve)
    }
    if (op === 'delete') {
      state.rows = state.rows.filter((r) => !match(r))
      return Promise.resolve({ data: null, error: null }).then(resolve)
    }
    return Promise.resolve({ data: state.rows.filter(match), error: null }).then(resolve)
  }
  return b
}

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: () => builder() }) }))
vi.mock('@/lib/auth/route-guard', () => ({
  guardRole: async (min: AccountRole) =>
    hasMinRole(state.role as AccountRole, min)
      ? { ok: true, ctx: { accountId: state.accountId, userId: `USER-${state.role}`, role: state.role } }
      : { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) },
}))
vi.mock('@/lib/ai/account-secrets', () => ({
  listAccountSecretNames: async () => state.names,
  loadAccountSecrets: async () => state.account,
}))
vi.mock('@/lib/ai-tools/usage', () => ({ loadToolUsage: async () => state.usage }))
vi.mock('@/lib/security/ssrf-guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/security/ssrf-guard')>()),
  safeFetch: async (url: string, init: any, options: any) => {
    state.fetchCalls.push({ url, init, options })
    return state.fetchImpl ? state.fetchImpl() : new Response('{"ok":true}', { status: 200 })
  },
}))

const { GET, POST } = await import('./route')
const { PATCH, DELETE } = await import('./[id]/route')
const { POST: TEST } = await import('./[id]/test/route')

const req = (method: string, body?: unknown, url = 'http://localhost/api/settings/tools') =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'buscar_cpf',
  display_name: 'Buscar CPF',
  description: 'Consulta o CPF',
  parameters: { type: 'object', properties: { cpf: { type: 'string', description: 'cpf' } }, required: ['cpf'] },
  http: { url: 'https://api.exemplo.com/cpf?cpf={{cpf}}', method: 'GET', headers: { Authorization: 'Bearer {{cred.API}}' } },
  ...over,
})
async function create(over: Record<string, unknown> = {}) {
  const res = await POST(req('POST', tool(over)))
  return { res, body: await res.json() }
}

describe('/api/settings/tools', () => {
  beforeEach(() => {
    state.role = 'admin'
    state.accountId = 'ACC-1'
    state.rows = []
    state.seq = 0
    state.usage = new Map()
    state.names = { credentials: ['API'], variables: [] }
    state.account = { vars: new Map(), creds: new Map([['API', { value: 'SEGREDO-ABCDEF123', hosts: ['exemplo.com'] }]]) }
    state.fetchCalls = []
    state.fetchImpl = null
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('papéis: agent/viewer nada; supervisor lê; admin/owner escrevem', async () => {
    await create()
    const id = state.rows[0].id
    for (const role of ['viewer', 'agent']) {
      state.role = role
      expect((await GET()).status).toBe(403)
      expect((await POST(req('POST', tool({ name: 'outra' })))).status).toBe(403)
    }
    state.role = 'supervisor'
    const list = await GET()
    expect(list.status).toBe(200)
    expect((await POST(req('POST', tool({ name: 'outra' })))).status).toBe(403)
    expect((await PATCH(req('PATCH', { enabled: false }), ctx(id))).status).toBe(403)
    expect((await DELETE(req('DELETE'), ctx(id))).status).toBe(403)
    expect((await TEST(req('POST', {}), ctx(id))).status).toBe(403)
    for (const role of ['admin', 'owner']) {
      state.role = role
      expect((await POST(req('POST', tool({ name: `t_${role}` })))).status).toBe(201)
    }
  })

  it('credencial literal → 400 "use {{cred.NOME}}" (URL, header e body); nada é gravado', async () => {
    const cases = [
      { http: { url: 'https://api.exemplo.com/x?tk=a1b2c3d4e5f6g7h8', method: 'GET' } },
      { http: { url: 'https://api.exemplo.com/x', method: 'GET', headers: { Authorization: 'Bearer abcdef123456' } } },
      { http: { url: 'https://api.exemplo.com/x', method: 'POST', body: '{"api_key":"abcdef123456"}' } },
    ]
    for (const c of cases) {
      const { res, body } = await create(c)
      expect(res.status).toBe(400)
      expect(body.error).toContain('{{cred.NOME}}')
    }
    expect(state.rows).toHaveLength(0)
  })

  it('URL http → 400; nome inválido → 400; duplicado → 409 (mesmo nome em outra conta é permitido)', async () => {
    expect((await create({ http: { url: 'http://api.exemplo.com', method: 'GET' } })).res.status).toBe(400)
    expect((await create({ name: 'Nome Ruim' })).res.status).toBe(400)
    expect((await create()).res.status).toBe(201)
    expect((await create()).res.status).toBe(409)
    state.accountId = 'ACC-2'
    expect((await create()).res.status).toBe(201)
  })

  it('{{cred}}/{{var}} que não existem na conta: salva e devolve warnings (não bloqueia)', async () => {
    state.names = { credentials: [], variables: [] }
    const { res, body } = await create()
    expect(res.status).toBe(201)
    expect(body.warnings).toEqual(['{{cred.API}}'])
  })

  it('GET: host, ligada/desligada, "usada em N fluxos" e nada de credencial', async () => {
    const { body } = await create()
    state.usage = new Map([[body.tool.id, new Set(['f1', 'f2'])]])
    const out = await (await GET()).json()
    expect(out.tools[0]).toMatchObject({ name: 'buscar_cpf', host: 'api.exemplo.com', enabled: true, used_in_flows: 2 })
    expect(JSON.stringify(out)).not.toContain('SEGREDO')
  })

  it('liga/desliga por PATCH {enabled} sem revalidar o resto', async () => {
    const { body } = await create()
    const id = body.tool.id
    const res = await PATCH(req('PATCH', { enabled: false }), ctx(id))
    expect((await res.json()).tool.enabled).toBe(false)
    expect(state.rows[0].enabled).toBe(false)
    expect((await PATCH(req('PATCH', { enabled: 'sim' }), ctx(id))).status).toBe(400)
  })

  it('PATCH completo revalida (literal → 400); nome é imutável', async () => {
    const { body } = await create()
    const id = body.tool.id
    const bad = await PATCH(req('PATCH', { http: { url: 'https://api.exemplo.com/x', method: 'GET', headers: { 'x-api-key': 'literal-123456' } } }), ctx(id))
    expect(bad.status).toBe(400)
    expect(state.rows[0].http.headers.Authorization).toBe('Bearer {{cred.API}}')
    expect((await PATCH(req('PATCH', { name: 'outro_nome' }), ctx(id))).status).toBe(400)
    const ok = await PATCH(req('PATCH', { description: 'Nova descrição', timeout_ms: 5000 }), ctx(id))
    expect(ok.status).toBe(200)
    expect(state.rows[0]).toMatchObject({ description: 'Nova descrição', timeout_ms: 5000, name: 'buscar_cpf' })
  })

  it('isolamento: PATCH/DELETE/test de outra conta → 404', async () => {
    const { body } = await create()
    const id = body.tool.id
    state.accountId = 'ACC-2'
    expect((await PATCH(req('PATCH', { enabled: false }), ctx(id))).status).toBe(404)
    expect((await DELETE(req('DELETE'), ctx(id))).status).toBe(404)
    expect((await TEST(req('POST', {}), ctx(id))).status).toBe(404)
    expect((await (await GET()).json()).tools).toEqual([])
    expect(state.rows).toHaveLength(1)
  })

  it('DELETE: 409 se usada em fluxos (force=true apaga)', async () => {
    const { body } = await create()
    const id = body.tool.id
    state.usage = new Map([[id, new Set(['f1'])]])
    const blocked = await DELETE(req('DELETE'), ctx(id))
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).used_in_flows).toBe(1)
    expect(state.rows).toHaveLength(1)
    expect((await DELETE(req('DELETE', undefined, 'http://localhost/x?force=true'), ctx(id))).status).toBe(200)
    expect(state.rows).toHaveLength(0)
  })

  it('DELETE: 409 se usada por qualquer versão de agente, mesmo com force', async () => {
    const { body } = await create()
    const id = body.tool.id
    // O mock compartilha as linhas entre tabelas: esta simula ai_agent_tools.
    state.rows.push({ account_id: state.accountId, tool_id: id, agent_version_id: 'v1' })
    const blocked = await DELETE(req('DELETE', undefined, 'http://localhost/x?force=true'), ctx(id))
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).used_by_agents).toBe(true)
    expect(state.rows.some((r) => r.id === id)).toBe(true)
  })

  describe('Testar ferramenta', () => {
    it('devolve só status + corpo sanitizado: sem URL/headers e com a credencial trocada por ***', async () => {
      const { body } = await create()
      state.fetchImpl = async () => new Response('eco: Bearer SEGREDO-ABCDEF123 fim', { status: 200 })
      const res = await TEST(req('POST', { arguments: { cpf: '123' } }), ctx(body.tool.id))
      const out = await res.json()
      expect(out).toEqual({ ok: true, status: 200, body: 'eco: Bearer *** fim' })
      const text = JSON.stringify(out)
      expect(text).not.toContain('SEGREDO')
      expect(text).not.toContain('api.exemplo.com')
      expect(text).not.toContain('Authorization')
      // A chamada real usou a credencial e bloqueia redirect cross-origin.
      expect(state.fetchCalls[0].url).toBe('https://api.exemplo.com/cpf?cpf=123')
      expect(state.fetchCalls[0].init.headers.Authorization).toBe('Bearer SEGREDO-ABCDEF123')
      expect(state.fetchCalls[0].options.failOnCrossOriginRedirect).toBe(true)
    })

    it('corpo da resposta cortado em 2 KB; status de erro volta como ok:false', async () => {
      const { body } = await create()
      state.fetchImpl = async () => new Response('x'.repeat(10_000), { status: 500 })
      const out = await (await TEST(req('POST', {}), ctx(body.tool.id))).json()
      expect(out.ok).toBe(false)
      expect(out.status).toBe(500)
      expect(out.body.length).toBeLessThanOrEqual(2048 + 20)
    })

    it('credencial ausente ou host fora da lista: não chama ninguém e não vaza a URL', async () => {
      const { body } = await create({ http: { url: 'https://evil.com/x', method: 'GET', headers: { Authorization: 'Bearer {{cred.API}}' } } })
      const out = await (await TEST(req('POST', {}), ctx(body.tool.id))).json()
      expect(out.ok).toBe(false)
      expect(out.error).toContain('cred.API')
      expect(JSON.stringify(out)).not.toContain('evil.com')
      expect(state.fetchCalls).toHaveLength(0)
    })

    it('erro do destino: mensagem genérica (o erro real pode conter a URL resolvida)', async () => {
      const { body } = await create()
      state.fetchImpl = async () => {
        throw new Error('getaddrinfo ENOTFOUND api.exemplo.com?cpf=123&token=SEGREDO')
      }
      const out = await (await TEST(req('POST', {}), ctx(body.tool.id))).json()
      expect(out).toEqual({ ok: false, error: 'Não foi possível chamar a ferramenta.' })
    })
  })
})
