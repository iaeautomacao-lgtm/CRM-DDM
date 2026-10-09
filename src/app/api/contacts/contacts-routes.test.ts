// PRD 23 grupo A: POST /api/contacts, PATCH /api/contacts/[id], tags e "número errado" — com Supabase em memória.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const ACC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'a0000000-0000-0000-0000-000000000002'
const TAG = 'e0000000-0000-0000-0000-000000000001'
const TAG_AUTO = 'e0000000-0000-0000-0000-000000000002'
const TAG_OTHER = 'e0000000-0000-0000-0000-000000000003'
const tables: Record<string, Row[]> = {}
let seq = 0
let denied = false
const audit = vi.fn()
let uniqueRaceOnInsert = false
let findCalls = 0

vi.mock('@/lib/auth/account', () => ({
  requirePermission: async (perm: string) => {
    if (denied) throw Object.assign(new Error('forbidden'), { status: 403, perm })
    return { accountId: ACC, userId: 'u1', supabase: null }
  },
  toErrorResponse: (e: { status?: number; message?: string }) =>
    new Response(JSON.stringify({ error: e.message }), { status: e.status ?? 500 }),
}))
vi.mock('@/lib/audit/log-event', () => ({ logAuditEvent: (...a: unknown[]) => audit(...a) }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: async (_db: unknown, account: string, phone: string) => {
    findCalls++
    // corrida: a 1ª busca ainda não vê o contato que o outro caminho está criando
    if (uniqueRaceOnInsert && findCalls === 1) return null
    return (tables.contacts ?? []).find((c) => c.account_id === account && c.phone === phone) ?? null
  },
  isUniqueViolation: (e: { code?: string }) => e?.code === '23505',
}))

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  let payload: Row = {}
  let opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  const b: Record<string, unknown> = {}
  b.select = () => b
  b.order = () => b
  b.limit = () => b
  b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
  b.insert = (p: Row) => ((op = 'insert'), (payload = p), b)
  b.update = (p: Row) => ((op = 'update'), (payload = p), b)
  b.delete = () => ((op = 'delete'), b)
  b.upsert = (p: Row, o: typeof opts) => ((op = 'upsert'), (payload = p), (opts = o ?? {}), b)
  b.then = (resolve: (v: unknown) => void) => {
    const rows = (tables[table] ??= [])
    const match = (r: Row) => filters.every((f) => f(r))
    if (op === 'insert') {
      if (uniqueRaceOnInsert) return resolve({ data: null, error: { code: '23505', message: 'dup' } })
      const created = { id: `ID-${++seq}`, ...payload }
      rows.push(created)
      return resolve({ data: [created], error: null })
    }
    if (op === 'upsert') {
      const keys = (opts.onConflict ?? 'id').split(',')
      const i = rows.findIndex((r) => keys.every((k) => r[k] === payload[k]))
      if (i >= 0) {
        if (!opts.ignoreDuplicates) rows[i] = { ...rows[i], ...payload }
      } else rows.push({ id: `ID-${++seq}`, ...payload })
      return resolve({ data: null, error: null })
    }
    if (op === 'update') {
      const hit = rows.filter(match)
      hit.forEach((r) => Object.assign(r, payload))
      return resolve({ data: hit, error: null })
    }
    if (op === 'delete') {
      tables[table] = rows.filter((r) => !match(r))
      return resolve({ data: null, error: null })
    }
    return resolve({ data: rows.filter(match), error: null })
  }
  return b
}
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }))

const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: 'POST', body: JSON.stringify(body) })
const patch = (url: string, body: unknown) => new Request(`http://x${url}`, { method: 'PATCH', body: JSON.stringify(body) })
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) })

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.contacts = [{ id: 'c1', account_id: ACC, phone: '5511999990001', phone_normalized: '5511999990001', name: 'Existente', cpf: null }]
  tables.tags = [
    { id: TAG, account_id: ACC, name: 'VIP', color: '#fff' },
    { id: TAG_AUTO, account_id: ACC, name: 'IA Conversando', color: '#000' },
    { id: TAG_OTHER, account_id: OTHER, name: 'Alheia', color: '#000' },
  ]
  tables.contact_tags = []
  tables.contact_phones = []
  denied = false
  uniqueRaceOnInsert = false
  findCalls = 0
  audit.mockClear()
})

describe('POST /api/contacts (item 5)', () => {
  it('cria o contato novo na conta do operador, com o operador como user_id e o CPF só em dígitos (resposta mascarada)', async () => {
    const { POST } = await import('./route')
    const r = await POST(post('/api/contacts', { name: 'Maria', phone: '+55 11 98888-7777', cpf: '529.982.247-25' }))
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j).toMatchObject({ created: true, contact: { name: 'Maria', phone: '5511988887777', cpf_masked: '***.***.***-25', has_cpf: true } })
    expect(JSON.stringify(j)).not.toContain('52998224725')
    expect(tables.contacts.at(-1)).toMatchObject({ account_id: ACC, user_id: 'u1', cpf: '52998224725' })
  })

  it('sem nome usa o telefone; telefone que já existe NÃO duplica (devolve o existente, created=false, sem alterar)', async () => {
    const { POST } = await import('./route')
    const novo = await (await POST(post('/api/contacts', { phone: '5511977776666' }))).json()
    expect(novo.contact.name).toBe('5511977776666')
    const before = tables.contacts.length
    const dup = await POST(post('/api/contacts', { name: 'Outro Nome', phone: '5511999990001', cpf: '529.982.247-25' }))
    expect(dup.status).toBe(200)
    expect(await dup.json()).toMatchObject({ created: false, contact: { id: 'c1', name: 'Existente' } })
    expect(tables.contacts).toHaveLength(before)
    expect(tables.contacts.find((c) => c.id === 'c1')?.cpf).toBeNull()
  })

  it('corrida (índice único): re-resolve o contato em vez de dar erro', async () => {
    uniqueRaceOnInsert = true
    const { POST } = await import('./route')
    const r = await POST(post('/api/contacts', { phone: '5511999990001' }))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ created: false, contact: { id: 'c1' } })
    expect(findCalls).toBe(2)
  })

  it('validações: telefone, CPF, e-mail e corpo', async () => {
    const { POST } = await import('./route')
    for (const body of [{ phone: '123' }, { phone: '5511977776666', cpf: '111.111.111-11' }, { phone: '5511977776666', email: 'x' }, {}]) {
      expect((await POST(post('/api/contacts', body))).status).toBe(400)
    }
  })

  it('sem a permissão contacts.edit: 403 e nada é criado', async () => {
    denied = true
    const { POST } = await import('./route')
    expect((await POST(post('/api/contacts', { phone: '5511977776666' }))).status).toBe(403)
    expect(tables.contacts).toHaveLength(1)
  })
})

describe('PATCH /api/contacts/[id] (item 4)', () => {
  it('atualiza nome/CPF/e-mail só do contato da própria conta; CPF volta mascarado; "" limpa o CPF', async () => {
    const { PATCH } = await import('./[id]/route')
    const r = await PATCH(patch('/api/contacts/c1', { name: 'Novo Nome', cpf: '529.982.247-25', email: 'A@B.com' }), ctx({ id: 'c1' }))
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.contact).toMatchObject({ name: 'Novo Nome', email: 'a@b.com', cpf_masked: '***.***.***-25' })
    expect(JSON.stringify(j)).not.toContain('52998224725')
    expect(tables.contacts[0].cpf).toBe('52998224725')
    await PATCH(patch('/api/contacts/c1', { cpf: '' }), ctx({ id: 'c1' }))
    expect(tables.contacts[0].cpf).toBeNull()
  })

  it('contato de outra conta = 404; CPF inválido, nome vazio e corpo sem campos = 400', async () => {
    tables.contacts.push({ id: 'cx', account_id: OTHER, phone: '5511900000000', name: 'Alheio', cpf: null })
    const { PATCH } = await import('./[id]/route')
    expect((await PATCH(patch('/api/contacts/cx', { name: 'Hack' }), ctx({ id: 'cx' }))).status).toBe(404)
    expect(tables.contacts.find((c) => c.id === 'cx')?.name).toBe('Alheio')
    for (const body of [{ cpf: '123' }, { name: '  ' }, {}]) expect((await PATCH(patch('/api/contacts/c1', body), ctx({ id: 'c1' }))).status).toBe(400)
  })

  it('sem permissão: 403', async () => {
    denied = true
    const { PATCH } = await import('./[id]/route')
    expect((await PATCH(patch('/api/contacts/c1', { name: 'X' }), ctx({ id: 'c1' }))).status).toBe(403)
  })
})

describe('tags do contato (item 20)', () => {
  it('liga (idempotente) e remove etiqueta da MESMA conta', async () => {
    const { POST } = await import('./[id]/tags/route')
    const { DELETE } = await import('./[id]/tags/[tagId]/route')
    expect((await POST(post('/x', { tag_id: TAG }), ctx({ id: 'c1' }))).status).toBe(200)
    expect((await POST(post('/x', { tag_id: TAG }), ctx({ id: 'c1' }))).status).toBe(200)
    expect(tables.contact_tags).toHaveLength(1)
    expect((await DELETE(new Request('http://x', { method: 'DELETE' }), ctx({ id: 'c1', tagId: TAG }))).status).toBe(200)
    expect(tables.contact_tags).toHaveLength(0)
  })

  it('etiqueta de outra conta = 404; as gerenciadas pela automação = 409; tag_id inválido = 400; contato alheio = 404', async () => {
    const { POST } = await import('./[id]/tags/route')
    const { DELETE } = await import('./[id]/tags/[tagId]/route')
    expect((await POST(post('/x', { tag_id: TAG_OTHER }), ctx({ id: 'c1' }))).status).toBe(404)
    expect((await POST(post('/x', { tag_id: TAG_AUTO }), ctx({ id: 'c1' }))).status).toBe(409)
    expect((await DELETE(new Request('http://x', { method: 'DELETE' }), ctx({ id: 'c1', tagId: TAG_AUTO }))).status).toBe(409)
    expect((await POST(post('/x', { tag_id: 'lixo' }), ctx({ id: 'c1' }))).status).toBe(400)
    expect((await POST(post('/x', { tag_id: TAG }), ctx({ id: 'nao-existe' }))).status).toBe(404)
    expect(tables.contact_tags).toHaveLength(0)
  })

  it('GET lista as da conta (sem as automáticas) e marca as aplicadas', async () => {
    tables.contact_tags.push({ contact_id: 'c1', tag_id: TAG })
    const { GET } = await import('./[id]/tags/route')
    const j = await (await GET(new Request('http://x'), ctx({ id: 'c1' }))).json()
    expect(j.available.map((t: { id: string }) => t.id)).toEqual([TAG])
    expect(j.applied.map((t: { id: string }) => t.id)).toEqual([TAG])
  })
})

describe('número errado (item 8)', () => {
  const call = async (body: unknown, id = 'c1') => {
    const { POST } = await import('./[id]/phones/invalid/route')
    return POST(post('/x', body), ctx({ id }))
  }

  it('ordem 2/3: marca o alternativo como inválido (e desfaz com ativo); inexistente = 404', async () => {
    tables.contact_phones.push({ id: 'p2', contact_id: 'c1', ordem: 2, phone_normalized: '5511911112222', status: 'ativo' })
    expect((await call({ ordem: 2 })).status).toBe(200)
    expect(tables.contact_phones[0].status).toBe('invalido')
    expect((await call({ ordem: 2, status: 'ativo' })).status).toBe(200)
    expect(tables.contact_phones[0].status).toBe('ativo')
    expect((await call({ ordem: 3 })).status).toBe(404)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'contact.phone_flagged', accountId: ACC }))
  })

  it('ordem 1: cria a linha do principal quando não existe (e atualiza se já existir)', async () => {
    expect((await call({ ordem: 1 })).status).toBe(200)
    expect(tables.contact_phones).toHaveLength(1)
    expect(tables.contact_phones[0]).toMatchObject({ contact_id: 'c1', ordem: 1, phone_normalized: '5511999990001', status: 'invalido' })
    expect((await call({ ordem: 1, status: 'ativo' })).status).toBe(200)
    expect(tables.contact_phones).toHaveLength(1)
    expect(tables.contact_phones[0].status).toBe('ativo')
  })

  it('valida ordem/status; contato de outra conta = 404 e nada muda; sem permissão = 403', async () => {
    tables.contacts.push({ id: 'cx', account_id: OTHER, phone: '5511900000000', phone_normalized: '5511900000000' })
    expect((await call({ ordem: 4 })).status).toBe(400)
    expect((await call({ ordem: 1, status: 'respondeu' })).status).toBe(400)
    expect((await call({ ordem: 1 }, 'cx')).status).toBe(404)
    expect(tables.contact_phones).toHaveLength(0)
    denied = true
    expect((await call({ ordem: 1 })).status).toBe(403)
  })
})
