import { beforeEach, describe, expect, it, vi } from 'vitest'

// PUT/DELETE /api/v1/contacts/{id}/owner (carteira fixa, fase 1): cadastro do atendente-dono, isolamento por conta, escopo e falta da migration 372.

type Row = Record<string, any>
const A = 'ACC-A'
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CONTACT = U(21)
const AGENT = U(1)

const h = vi.hoisted(() => ({ scopes: ['contacts:write'] as string[], db: {} as Record<string, Row[]>, updateError: null as null | { code?: string; message: string }, audit: [] as any[] }))

class Q {
  filters: Array<(r: Row) => boolean> = []
  op: 'select' | 'update' = 'select'
  payload: any = null
  lim = Infinity
  constructor(private table: string) {}
  select() { return this }
  update(p: any) { this.op = 'update'; this.payload = p; return this }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
  limit(n: number) { this.lim = n; return this }
  then(resolve: (v: unknown) => void) {
    const rows = (h.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)))
    if (this.op === 'update') {
      if (h.updateError) return resolve({ data: null, error: h.updateError })
      rows.forEach((r) => Object.assign(r, this.payload))
      return resolve({ data: rows, error: null })
    }
    resolve({ data: rows.slice(0, this.lim), error: null })
  }
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async (_r: Request, scope: string) => {
    if (!h.scopes.includes(scope)) {
      const { forbidden } = await import('@/lib/api/v1/respond')
      throw forbidden('sem escopo')
    }
    return { accountId: A, keyId: 'KEY', scopes: h.scopes, createdBy: null, userId: null, supabase: { from: (t: string) => new Q(t) } }
  },
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/audit/context', () => ({ registerAuditActor: async (a: unknown) => void h.audit.push(a) }))

const owner = await import('./contacts/[id]/owner/route')

const call = (method: 'PUT' | 'DELETE', id: string, body?: unknown) =>
  (method === 'PUT' ? owner.PUT : owner.DELETE)(new Request('http://localhost/x', { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const json = async (r: Response) => (await r.json()) as any

beforeEach(() => {
  h.scopes = ['contacts:write']
  h.updateError = null
  h.audit = []
  h.db = {
    contacts: [{ id: CONTACT, account_id: A, owner_user_id: null }, { id: U(22), account_id: 'ACC-B', owner_user_id: null }],
    profiles: [
      { user_id: AGENT, account_id: A, full_name: 'Ana Souza', account_role: 'agent', deactivated_at: null },
      { user_id: U(2), account_id: A, full_name: 'Desativado', account_role: 'agent', deactivated_at: '2026-01-01' },
      { user_id: U(3), account_id: A, full_name: 'Visitante', account_role: 'viewer', deactivated_at: null },
      { user_id: U(4), account_id: 'ACC-B', full_name: 'De outra conta', account_role: 'agent', deactivated_at: null },
    ],
  }
})

describe('PUT /contacts/{id}/owner', () => {
  it('grava o dono, devolve nome e registra a origem API na auditoria', async () => {
    const res = await call('PUT', CONTACT, { assignee_id: AGENT })
    expect(res.status).toBe(200)
    expect((await json(res)).data).toEqual({ contact_id: CONTACT, owner: { id: AGENT, name: 'Ana Souza' } })
    expect(h.db.contacts[0].owner_user_id).toBe(AGENT)
    expect(h.audit[0]).toEqual({ actorType: 'api', source: 'api_v1' })
  })

  it('repetir é seguro; trocar de dono substitui', async () => {
    await call('PUT', CONTACT, { assignee_id: AGENT })
    expect((await call('PUT', CONTACT, { assignee_id: AGENT })).status).toBe(200)
    h.db.profiles.push({ user_id: U(5), account_id: A, full_name: 'Beto', account_role: 'supervisor', deactivated_at: null })
    await call('PUT', CONTACT, { assignee_id: U(5) })
    expect(h.db.contacts[0].owner_user_id).toBe(U(5))
  })

  it('atendente de outra conta, desativado ou visualizador = 404; contato de outra conta/id ruim = 404; nada é gravado', async () => {
    for (const assignee of [U(4), U(2), U(3), U(99)]) expect((await call('PUT', CONTACT, { assignee_id: assignee })).status, assignee).toBe(404)
    expect((await call('PUT', U(22), { assignee_id: AGENT })).status).toBe(404)
    expect((await call('PUT', 'abc', { assignee_id: AGENT })).status).toBe(404)
    expect(h.db.contacts.every((c) => c.owner_user_id === null)).toBe(true)
  })

  it('validação: corpo, assignee_id obrigatório/UUID, campo desconhecido', async () => {
    for (const body of [undefined, {}, { assignee_id: 'x' }, { assignee_id: null }, { assignee_id: AGENT, foo: 1 }, []]) {
      expect((await call('PUT', CONTACT, body as never)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('sem a migration 372 (coluna ausente): 503 explicando; outro escopo = 403', async () => {
    h.updateError = { code: '42703', message: 'column owner_user_id does not exist' }
    const res = await call('PUT', CONTACT, { assignee_id: AGENT })
    expect(res.status).toBe(503)
    expect((await json(res)).error).toMatchObject({ code: 'unavailable', message: expect.stringContaining('372') })
    h.updateError = null
    h.scopes = ['contacts:read']
    expect((await call('PUT', CONTACT, { assignee_id: AGENT })).status).toBe(403)
  })
})

describe('DELETE /contacts/{id}/owner', () => {
  it('remove o dono; repetir é seguro; contato de outra conta = 404', async () => {
    h.db.contacts[0].owner_user_id = AGENT
    const res = await call('DELETE', CONTACT)
    expect(res.status).toBe(200)
    expect((await json(res)).data).toEqual({ contact_id: CONTACT, owner: null })
    expect(h.db.contacts[0].owner_user_id).toBeNull()
    expect((await call('DELETE', CONTACT)).status).toBe(200)
    expect((await call('DELETE', U(22))).status).toBe(404)
  })
})
