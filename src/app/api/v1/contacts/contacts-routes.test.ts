import { beforeEach, describe, expect, it, vi } from 'vitest'

// /api/v1/contacts: busca, upsert (só preenche vazios), PATCH (sobrescreve), isolamento por conta e CPF nunca em claro.
// O banco é um fake em memória (as consultas reais passam pelos mesmos filtros), então o teste exercita a lógica de verdade.

type Row = Record<string, any>
const A = 'ACC-A'
const B = 'ACC-B'
const CPF = '52998224725' // CPF válido
const CPF2 = '11144477735' // CPF válido

const h = vi.hoisted(() => ({
  scopes: ['contacts:write'] as string[],
  createdBy: 'USER-1' as string | null,
  rate: true,
  audits: [] as any[],
  blindFirstFind: false,
  seq: 0,
  db: {} as Record<string, Row[]>,
}))

const digits = (s: string) => s.replace(/\D/g, '')

function likeToRegex(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    else if (c === '%') out += '.*'
    else if (c === '_') out += '.'
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

class Q {
  filters: Array<(r: Row) => boolean> = []
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  payload: any = null
  opts: any = {}
  orders: Array<[string, boolean]> = []
  lim = Infinity
  constructor(private table: string) {}
  select() { return this }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this }
  update(p: any) { this.op = 'update'; this.payload = p; return this }
  delete() { this.op = 'delete'; return this }
  upsert(p: any, o: any) { this.op = 'upsert'; this.payload = p; this.opts = o ?? {}; return this }
  eq(c: string, v: unknown) {
    if (c === 'contact_tags.tag_id') this.filters.push((r) => h.db.contact_tags.some((l) => l.contact_id === r.id && l.tag_id === v))
    else this.filters.push((r) => r[c] === v)
    return this
  }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  gte(c: string, v: any) { this.filters.push((r) => (c === 'ordem' ? r[c] >= v : r[c] >= v)); return this }
  lt(c: string, v: any) { this.filters.push((r) => r[c] < v); return this }
  ilike(c: string, p: string) { const re = likeToRegex(p); this.filters.push((r) => typeof r[c] === 'string' && re.test(r[c])); return this }
  or(expr: string) {
    const m = expr.match(/^updated_at\.gt\.(.+?),and\(updated_at\.eq\.(.+?),id\.gt\.(.+)\)$/)
    if (!m) throw new Error(`or não suportado: ${expr}`)
    const [, ts, , id] = m
    this.filters.push((r) => r.updated_at > ts || (r.updated_at === ts && r.id > id))
    return this
  }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push([c, o?.ascending !== false]); return this }
  limit(n: number) { this.lim = n; return this }
  private embed(r: Row): Row {
    if (this.table === 'contact_tags') return { ...r, tags: h.db.tags.find((t) => t.id === r.tag_id) ?? null }
    if (this.table === 'contact_custom_values') return { ...r, custom_fields: h.db.custom_fields.find((f) => f.id === r.custom_field_id) ?? null }
    return r
  }
  private violates(row: Row): boolean {
    const t = this.table
    const rows = h.db[t]
    if (t === 'contacts') return rows.some((r) => r.account_id === row.account_id && digits(r.phone) === digits(row.phone))
    if (t === 'tags') return rows.some((r) => r.account_id === row.account_id && r.name.toLowerCase() === row.name.toLowerCase())
    if (t === 'contact_phones') return rows.some((r) => r.contact_id === row.contact_id && r.ordem === row.ordem)
    return false
  }
  private run(): { data: any; error: any } {
    const rows = h.db[this.table]
    if (this.op === 'insert') {
      const row: Row = { id: `${this.table}-${++h.seq}`, created_at: '2026-10-01T00:00:00.000Z', updated_at: `2026-10-01T00:00:${String(h.seq % 60).padStart(2, '0')}.000Z`, ...this.payload }
      if (this.violates(row)) return { data: null, error: { code: '23505', message: 'dup' } }
      rows.push(row)
      return { data: [row], error: null }
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.op === 'update') {
      matched.forEach((r) => Object.assign(r, this.payload))
      return { data: matched, error: null }
    }
    if (this.op === 'delete') {
      h.db[this.table] = rows.filter((r) => !matched.includes(r))
      return { data: null, error: null }
    }
    if (this.op === 'upsert') {
      const list: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload]
      const keys = String(this.opts.onConflict ?? '').split(',')
      for (const p of list) {
        const hit = rows.find((r) => keys.every((k) => r[k] === p[k]))
        if (hit) { if (!this.opts.ignoreDuplicates) Object.assign(hit, p) } else rows.push({ id: `${this.table}-${++h.seq}`, ...p })
      }
      return { data: null, error: null }
    }
    let out = matched.map((r) => this.embed(r))
    for (const [c, asc] of [...this.orders].reverse()) out = out.sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)))
    return { data: out.slice(0, this.lim), error: null }
  }
  then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
    try { resolve(this.run()) } catch (e) { reject?.(e) }
  }
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async (_r: Request, scope: string | string[]) => {
    const needed = Array.isArray(scope) ? scope : [scope]
    if (!needed.some((s) => h.scopes.includes(s))) {
      const { forbidden } = await import('@/lib/api/v1/respond')
      throw forbidden('sem escopo')
    }
    return { accountId: A, keyId: 'KEY', scopes: h.scopes, createdBy: h.createdBy, userId: null, supabase: { from: (t: string) => new Q(t) } }
  },
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/api/v1/extract-audit', () => ({ auditExtraction: async (a: any) => void h.audits.push(a) }))
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: async () => ({ success: h.rate, limit: 60, remaining: 0, reset: Date.now() + 30_000 }),
}))
vi.mock('@/lib/contacts/dedupe', async (orig) => ({
  ...(await orig<typeof import('@/lib/contacts/dedupe')>()),
  findExistingContact: async (_db: unknown, account: string, phone: string) => {
    if (h.blindFirstFind) { h.blindFirstFind = false; return null }
    const d = digits(phone)
    const primary = h.db.contacts.find((c) => c.account_id === account && digits(c.phone) === d)
    if (primary) return primary
    const alt = h.db.contact_phones.find((p) => p.phone_normalized === d)
    return alt ? (h.db.contacts.find((c) => c.id === alt.contact_id && c.account_id === account) ?? null) : null
  },
}))

const list = await import('./route')
const one = await import('./[id]/route')

const call = (handler: (r: Request, c?: any) => Promise<Response>, method: string, url: string, body?: unknown, headers: Record<string, string> = {}, id?: string) =>
  handler(new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), id ? { params: Promise.resolve({ id }) } : undefined)
const post = (body: unknown, headers?: Record<string, string>) => call(list.POST, 'POST', '/api/v1/contacts', body, headers)
const get = (qs: string) => call(list.GET, 'GET', `/api/v1/contacts${qs}`)
const getOne = (id: string) => call(one.GET, 'GET', `/api/v1/contacts/${id}`, undefined, {}, id)
const patch = (id: string, body: unknown) => call(one.PATCH, 'PATCH', `/api/v1/contacts/${id}`, body, {}, id)
const json = async (r: Response) => (await r.json()) as any
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function seed() {
  h.db = {
    contacts: [
      { id: UUID(1), account_id: A, phone: '5527999991212', name: 'Ana Souza', email: null, company: null, instituicao: null, cpf: CPF, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
      { id: UUID(2), account_id: A, phone: '5511988880000', name: '5511988880000', email: 'b@x.com', company: 'Empresa B', instituicao: null, cpf: null, created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' },
      { id: UUID(3), account_id: B, phone: '5521977770000', name: 'Outra Conta', email: null, company: null, instituicao: null, cpf: CPF, created_at: '2026-10-03T00:00:00.000Z', updated_at: '2026-10-03T00:00:00.000Z' },
    ],
    contact_phones: [{ id: 'cp1', contact_id: UUID(1), phone: '+5527988887777', phone_normalized: '5527988887777', ordem: 2, status: 'ativo', label: 'Trabalho' }],
    tags: [
      { id: 'tag-1', account_id: A, name: 'Inadimplente', kind: 'contact' },
      { id: 'tag-2', account_id: A, name: 'Acordo fechado', kind: 'outcome' },
      { id: 'tag-3', account_id: A, name: 'Acordo', kind: 'contact' },
    ],
    contact_tags: [
      { contact_id: UUID(1), tag_id: 'tag-1' },
      { contact_id: UUID(1), tag_id: 'tag-2' },
    ],
    custom_fields: [
      { id: 'cf-1', account_id: A, field_name: 'Curso' },
      { id: 'cf-2', account_id: A, field_name: 'Turma' },
    ],
    contact_custom_values: [{ id: 'v1', contact_id: UUID(1), custom_field_id: 'cf-1', value: 'Direito' }],
    accounts: [{ id: A, owner_user_id: 'OWNER-1' }],
  }
}

beforeEach(() => {
  Object.assign(h, { scopes: ['contacts:write'], createdBy: 'USER-1', rate: true, audits: [], blindFirstFind: false, seq: 100 })
  seed()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /contacts', () => {
  it('sem nenhum filtro → 400; sem escopo → 403; limite → 429', async () => {
    expect((await get('')).status).toBe(400)
    h.scopes = ['reports:read']
    expect((await get('?cpf=' + CPF)).status).toBe(403)
    h.scopes = ['contacts:read']
    h.rate = false
    expect((await get('?cpf=' + CPF)).status).toBe(429)
  })

  it('por telefone alternativo: acha o contato, CPF só mascarado, etiqueta de tabulação fora, campos e alternativos no item', async () => {
    h.scopes = ['contacts:read']
    const res = await get('?phone=5527988887777')
    expect(res.status).toBe(200)
    const { items } = (await json(res)).data
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: UUID(1),
      phone: '5527999991212',
      phones: [{ phone: '+5527988887777', status: 'ativo', label: 'Trabalho' }],
      cpf_masked: '***.***.***-25',
      has_cpf: true,
      tags: ['Inadimplente'],
      custom_fields: { Curso: 'Direito' },
      institution: null,
    })
    expect(JSON.stringify(items)).not.toContain(CPF)
    expect(items[0]).not.toHaveProperty('cpf')
    expect(h.audits[0]).toMatchObject({ route: '/api/v1/contacts', itemCount: 1 })
    expect(JSON.stringify(h.audits)).not.toContain(CPF)
  })

  it('cpf é só da conta da chave (o mesmo CPF em outra conta não aparece); inválido → 400', async () => {
    h.scopes = ['contacts:read']
    const { items } = (await json(await get('?cpf=' + CPF))).data
    expect(items.map((i: any) => i.id)).toEqual([UUID(1)])
    expect((await get('?cpf=123')).status).toBe(400)
  })

  it('email, q (3+ letras), tag e janela de updated_*', async () => {
    h.scopes = ['contacts:read']
    expect((await json(await get('?email=B@X.com'))).data.items.map((i: any) => i.id)).toEqual([UUID(2)])
    expect((await json(await get('?q=ana'))).data.items.map((i: any) => i.id)).toEqual([UUID(1)])
    expect((await get('?q=an')).status).toBe(400)
    expect((await json(await get('?tag=inadimplente'))).data.items.map((i: any) => i.id)).toEqual([UUID(1)])
    expect((await json(await get('?tag=nao-existe'))).data.items).toEqual([])
    expect((await json(await get('?updated_from=2026-10-02T00:00:00Z'))).data.items.map((i: any) => i.id)).toEqual([UUID(2)])
  })

  it('paginação por cursor (updated_at, id) sem repetir nem pular', async () => {
    h.scopes = ['contacts:read']
    const first = (await json(await get('?updated_from=2026-01-01T00:00:00Z&limit=1'))).data
    expect(first.items.map((i: any) => i.id)).toEqual([UUID(1)])
    expect(first.next_cursor).toBeTruthy()
    const second = (await json(await get(`?updated_from=2026-01-01T00:00:00Z&limit=1&cursor=${first.next_cursor}`))).data
    expect(second.items.map((i: any) => i.id)).toEqual([UUID(2)])
    expect(second.next_cursor).toBeNull()
    expect((await get('?updated_from=2026-01-01T00:00:00Z&cursor=lixo')).status).toBe(400)
  })
})

describe('carteira fixa no contato', () => {
  it('GET /contacts/{id} e a busca trazem owner {id,name}; sem dono = null; sem a coluna (migration 372) = null', async () => {
    h.scopes = ['contacts:read']
    h.db.profiles = [{ user_id: UUID(5), account_id: A, full_name: 'Ana', account_role: 'agent' }]
    h.db.contacts[0].owner_user_id = UUID(5)
    expect((await json(await getOne(UUID(1)))).data.contact.owner).toEqual({ id: UUID(5), name: 'Ana' })
    expect((await json(await getOne(UUID(2)))).data.contact.owner).toBeNull()
    const list = (await json(await get('?cpf=' + CPF))).data.items[0]
    expect(list.owner).toEqual({ id: UUID(5), name: 'Ana' })
    delete h.db.contacts[0].owner_user_id
    expect((await json(await getOne(UUID(1)))).data.contact.owner).toBeNull()
  })
})

describe('GET /contacts/{id}', () => {
  it('devolve o contato; de outra conta ou id inválido → 404', async () => {
    h.scopes = ['contacts:read']
    const res = await getOne(UUID(1))
    expect(res.status).toBe(200)
    expect((await json(res)).data.contact).toMatchObject({ id: UUID(1), has_cpf: true, cpf_masked: '***.***.***-25' })
    expect((await getOne(UUID(3))).status).toBe(404)
    expect((await getOne('abc')).status).toBe(404)
  })
})

describe('POST /contacts (upsert)', () => {
  it('cria: 201, nome padrão = telefone, etiquetas novas (kind contact), campos, alternativos e CPF só mascarado', async () => {
    const res = await post({ phone: '+55 (31) 98888-1111', email: 'NOVO@x.com', cpf: CPF2, institution: 'Fac', phones: ['5531977772222'], tags: ['Nova Etiqueta'], custom_fields: { Curso: 'Letras' } })
    expect(res.status).toBe(201)
    const data = (await json(res)).data
    expect(data).toMatchObject({ created: true, updated_fields: [], ignored_phones: [] })
    expect(data.contact).toMatchObject({ phone: '5531988881111', email: 'novo@x.com', institution: 'Fac', has_cpf: true, tags: ['Nova Etiqueta'], custom_fields: { Curso: 'Letras' } })
    expect(data.contact.phones).toEqual([{ phone: '+5531977772222', status: null, label: null }])
    expect(JSON.stringify(data)).not.toContain(CPF2)
    const row = h.db.contacts.find((c) => c.id === data.contact.id)!
    expect(row).toMatchObject({ account_id: A, user_id: 'USER-1', instituicao: 'Fac', cpf: CPF2 })
    expect(h.db.tags.find((t) => t.name === 'Nova Etiqueta')).toMatchObject({ account_id: A, kind: 'contact', user_id: 'USER-1' })
  })

  it('sem created_by na chave, grava como o dono da conta', async () => {
    h.createdBy = null
    const data = (await json(await post({ phone: '5531988881111' }))).data
    expect(h.db.contacts.find((c) => c.id === data.contact.id)!.user_id).toBe('OWNER-1')
  })

  it('existente (por telefone): preenche SÓ vazios, nome-telefone conta como vazio, nunca troca o principal', async () => {
    const res = await post({ phone: '5511988880000', name: 'Beto Lima', email: 'outro@x.com', company: 'Outra', institution: 'Fac B', cpf: CPF2 })
    expect(res.status).toBe(200)
    const data = (await json(res)).data
    expect(data.created).toBe(false)
    expect(data.updated_fields.sort()).toEqual(['cpf', 'institution', 'name'])
    expect(data.contact).toMatchObject({ id: UUID(2), phone: '5511988880000', name: 'Beto Lima', email: 'b@x.com', company: 'Empresa B', institution: 'Fac B', has_cpf: true })
  })

  it('repetir a mesma chamada não muda nada (idempotente): updated_fields vazio', async () => {
    const body = { phone: '5511988880000', name: 'Beto Lima' }
    await post(body, { 'idempotency-key': 'chave-0001-abcd' })
    const again = await json(await post(body, { 'idempotency-key': 'chave-0001-abcd' }))
    expect(again.data).toMatchObject({ created: false, updated_fields: [] })
  })

  it('identidade pelo CPF antes do telefone: telefone novo + CPF existente = mesmo contato, principal intacto, nome não sobrescrito', async () => {
    const res = await post({ phone: '5599911112222', cpf: CPF, name: 'Outro Nome' })
    const data = (await json(res)).data
    expect(res.status).toBe(200)
    expect(data.contact).toMatchObject({ id: UUID(1), phone: '5527999991212', name: 'Ana Souza' })
    expect(data.updated_fields).toEqual([])
    expect(h.db.contacts.filter((c) => c.account_id === A)).toHaveLength(2)
  })

  it('telefones que já são de algum contato vão em ignored_phones; etiqueta/campos só entram se faltam', async () => {
    const data = (await json(await post({ phone: '5527999991212', phones: ['5511988880000', '5527955554444'], tags: ['inadimplente', 'Acordo'], custom_fields: { Curso: 'Outro', Turma: 'A' } }))).data
    expect(data.ignored_phones).toEqual(['5511988880000'])
    expect(data.contact.phones.map((p: any) => p.phone)).toEqual(['+5527988887777', '+5527955554444'])
    expect(data.contact.tags).toEqual(['Acordo', 'Inadimplente'])
    expect(data.contact.custom_fields).toEqual({ Curso: 'Direito', Turma: 'A' })
    expect(data.updated_fields.sort()).toEqual(['custom_fields', 'phones', 'tags'])
  })

  it('campo personalizado inexistente → 422 com a lista e NADA gravado (nem o contato)', async () => {
    const res = await post({ phone: '5531988881111', custom_fields: { Curso: 'x', Inventado: 'y', Outro: 'z' } })
    expect(res.status).toBe(422)
    expect((await json(res)).error).toMatchObject({ code: 'unprocessable', unknown_custom_fields: ['Inventado', 'Outro'] })
    expect(h.db.contacts).toHaveLength(3)
  })

  it('corrida na chave única do telefone: refaz a leitura e responde 200 created:false', async () => {
    h.blindFirstFind = true
    const res = await post({ phone: '5511988880000', email: 'novo@x.com' })
    expect(res.status).toBe(200)
    expect((await json(res)).data).toMatchObject({ created: false })
    expect(h.db.contacts.filter((c) => c.account_id === A)).toHaveLength(2)
  })

  it('validações: telefone, CPF, e-mail, campo desconhecido, etiqueta automática, corpo, chave de idempotência', async () => {
    for (const body of [{}, { phone: '123' }, { phone: '5531988881111', cpf: '111.111.111-11' }, { phone: '5531988881111', email: 'x' }, { phone: '5531988881111', foo: 1 }, { phone: '5531988881111', tags: ['IA Conversando'] }, { phone: '5531988881111', tags: 'x' }, { phone: '5531988881111', custom_fields: [] }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await call(list.POST, 'POST', '/api/v1/contacts', undefined)).status).toBe(400)
    expect((await post({ phone: '5531988881111' }, { 'idempotency-key': 'curta' })).status).toBe(400)
    expect(h.db.contacts).toHaveLength(3)
  })

  it('chave só com contacts:read não grava (403)', async () => {
    h.scopes = ['contacts:read']
    expect((await post({ phone: '5531988881111' })).status).toBe(403)
  })
})

describe('PATCH /contacts/{id}', () => {
  it('sobrescreve; null limpa e-mail/empresa; nome vazio não apaga; mesmo telefone principal é aceito', async () => {
    const res = await patch(UUID(2), { phone: '5511988880000', name: '', email: null, company: 'Nova', institution: 'Fac', cpf: CPF2 })
    expect(res.status).toBe(200)
    const data = (await json(res)).data
    expect(data.contact).toMatchObject({ name: '5511988880000', email: null, company: 'Nova', institution: 'Fac', has_cpf: true })
    expect(data.updated_fields.sort()).toEqual(['company', 'cpf', 'email', 'institution'])
    expect(JSON.stringify(data)).not.toContain(CPF2)
  })

  it('telefone principal diferente → 400; sem campo → 400; 404 de outra conta; campo desconhecido → 400', async () => {
    expect((await patch(UUID(1), { phone: '5599911112222' })).status).toBe(400)
    expect((await patch(UUID(1), {})).status).toBe(400)
    expect((await patch(UUID(3), { company: 'x' })).status).toBe(404)
    expect((await patch(UUID(1), { foo: 1 })).status).toBe(400)
    expect(h.db.contacts.find((c) => c.id === UUID(3))!.company).toBeNull()
  })

  it('tags add/remove (cria a nova; remove ignora a que não tem; automática = 400) e custom_fields em merge/null', async () => {
    const res = await patch(UUID(1), { tags: { add: ['Nova', 'Acordo'], remove: ['Inadimplente', 'Inexistente'] }, custom_fields: { Curso: null, Turma: 'B' } })
    const data = (await json(res)).data
    expect(res.status).toBe(200)
    expect(data.contact.tags).toEqual(['Acordo', 'Nova'])
    expect(data.contact.custom_fields).toEqual({ Turma: 'B' })
    expect(data.updated_fields.sort()).toEqual(['custom_fields', 'tags'])
    expect((await patch(UUID(1), { tags: { add: ['Atendimento Humano'] } })).status).toBe(400)
    // A tabulação de conversa continua intacta (não é etiqueta de contato).
    expect(h.db.contact_tags.some((l) => l.contact_id === UUID(1) && l.tag_id === 'tag-2')).toBe(true)
  })

  it('campo personalizado inexistente → 422 e nada alterado', async () => {
    const res = await patch(UUID(1), { company: 'Mudou', custom_fields: { Inventado: 'x' } })
    expect(res.status).toBe(422)
    expect(h.db.contacts.find((c) => c.id === UUID(1))!.company).toBeNull()
  })

  it('phones vira a lista exata de alternativos; número de outro contato → 409', async () => {
    const ok = await json(await patch(UUID(1), { phones: ['5527955554444'] }))
    expect(ok.data.contact.phones.map((p: any) => p.phone)).toEqual(['+5527955554444'])
    expect(ok.data.updated_fields).toEqual(['phones'])
    const clash = await patch(UUID(1), { phones: ['5511988880000'] })
    expect(clash.status).toBe(409)
    expect((await json(clash)).error).toMatchObject({ code: 'conflict', reason: 'phone_in_use' })
  })

  it('exige contacts:write', async () => {
    h.scopes = ['contacts:read']
    expect((await patch(UUID(1), { company: 'x' })).status).toBe(403)
  })
})
