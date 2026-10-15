import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/v1/conversations, /{id}/close e /{id}/transfer (Onda 2): abrir/reaproveitar, atendente × equipe, pausa (409 + confirm_paused),
// force_transfer, mensagem inicial (24h/template/WAHA), encerrar com tabulação e nota, isolamento por conta, escopos e limite.

type Row = Record<string, any>
const A = 'ACC-A'
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const AGENT = U(1)
const AGENT2 = U(2)
const TEAM = U(11)
const CONTACT = U(21)
const CONV = U(31)
const META = U(41)
const WAHA = U(42)
const TAB = U(51)
const KEY_CREATOR = U(99)

const h = vi.hoisted(() => ({
  scopes: ['conversations:write'] as string[],
  createdBy: null as string | null,
  rate: true,
  seq: 0,
  db: {} as Record<string, Row[]>,
  sent: [] as any[],
  endedRuns: [] as string[],
  audit: [] as any[],
  providerCalled: 0,
  ledgerReleased: 0,
  blocked: [] as Array<{ key: string }>,
  red: [] as any[],
  sendError: null as unknown,
}))

const digits = (s: string) => s.replace(/\D/g, '')

class Q {
  filters: Array<(r: Row) => boolean> = []
  op: 'select' | 'insert' | 'update' = 'select'
  payload: any = null
  orders: Array<[string, boolean]> = []
  lim = Infinity
  constructor(private table: string) {}
  select() { return this }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this }
  update(p: any) { this.op = 'update'; this.payload = p; return this }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push([c, o?.ascending !== false]); return this }
  limit(n: number) { this.lim = n; return this }
  private run() {
    const rows = h.db[this.table] ?? (h.db[this.table] = [])
    if (this.op === 'insert') {
      const row = { id: U(1000 + ++h.seq), created_at: new Date().toISOString(), ...(this.table === 'conversations' ? { channel_type: 'whatsapp' } : {}), ...this.payload }
      rows.push(row)
      return { data: [row], error: null }
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.op === 'update') {
      for (const r of matched) {
        const before = { ...r }
        Object.assign(r, this.payload)
        if (this.table === 'conversations') {
          if (r.status === 'closed' && !r.closed_at) r.closed_at = new Date().toISOString()
          // trigger log_conversation_assignment (ator nulo sob service role)
          if (before.assigned_agent_id !== r.assigned_agent_id || before.team_id !== r.team_id) {
            h.db.conversation_assignments.push({ id: U(2000 + ++h.seq), conversation_id: r.id, actor_id: null, reason: null, created_at: new Date().toISOString() })
          }
        }
      }
      return { data: matched, error: null }
    }
    let out = [...matched]
    for (const [c, asc] of [...this.orders].reverse()) out = out.sort((a, b) => (a[c] === b[c] ? 0 : (a[c] ?? '') > (b[c] ?? '') ? (asc ? 1 : -1) : asc ? -1 : 1))
    return { data: out.slice(0, this.lim), error: null }
  }
  then(resolve: (v: unknown) => void) { resolve(this.run()) }
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async (_r: Request, scope: string | string[]) => {
    const needed = Array.isArray(scope) ? scope : [scope]
    if (!needed.some((s) => h.scopes.includes(s))) {
      const { forbidden } = await import('@/lib/api/v1/respond')
      throw forbidden('sem escopo')
    }
    return {
      accountId: A, keyId: 'KEY', scopes: h.scopes, createdBy: h.createdBy, userId: null,
      supabase: { from: (t: string) => new Q(t), rpc: async () => ({ data: h.blocked, error: null }) },
    }
  },
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: async () => ({ success: h.rate, limit: 30, remaining: 0, reset: Date.now() + 30_000 }),
}))
vi.mock('@/lib/flows/engine', () => ({ endActiveRunForConversation: async (id: string) => void h.endedRuns.push(id) }))
vi.mock('@/lib/audit/context', () => ({ registerAuditActor: async (a: unknown) => void h.audit.push(a) }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: async (_db: unknown, account: string, phone: string) => h.db.contacts.find((c) => c.account_id === account && digits(c.phone) === digits(phone)) ?? null,
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/disparador/red-quality-gate', async (orig) => ({ ...(await orig<typeof import('@/lib/disparador/red-quality-gate')>()), findRedChannels: async () => h.red }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}`, decryptStoredSecret: (s: string) => `dec:${s}`, encrypt: (s: string) => s }))
vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: async (a: any) => { if (h.sendError) throw h.sendError; h.sent.push({ kind: 'meta-template', ...a }); return { messageId: 'wamid.tpl' } },
  sendTextMessage: async (a: any) => { if (h.sendError) throw h.sendError; h.sent.push({ kind: 'meta-text', ...a }); return { messageId: 'wamid.txt' } },
}))
vi.mock('@/lib/whatsapp/waha-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/waha-api')>()),
  sendWahaTextMessage: async (cfg: any, phone: string, text: string) => { h.sent.push({ kind: 'waha-text', cfg, phone, text }); return { messageId: 'waha-1' } },
}))
vi.mock('@/lib/disparador/send-ledger', () => ({
  runIdempotentSend: async (_a: string, request: Request, work: (ctl: any) => Promise<Response>) => {
    const { badRequest } = await import('@/lib/api/v1/respond')
    if (!request.headers.get('idempotency-key')) throw badRequest('Informe uma chave Idempotency-Key por intenção de envio')
    let called = false
    try {
      return await work({ providerCalled: () => { called = true; h.providerCalled++ } })
    } catch (e) {
      if (!called) h.ledgerReleased++
      throw e
    }
  },
}))

const conversations = await import('./conversations/route')
const close = await import('./conversations/[id]/close/route')
const transfer = await import('./conversations/[id]/transfer/route')
const { MetaApiError } = await import('@/lib/whatsapp/meta-api')

const open = (body: unknown, headers: Record<string, string> = {}) =>
  conversations.POST(new Request('http://localhost/api/v1/conversations', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
const idem = { 'idempotency-key': 'abertura-0001' }
const closeCall = (id: string, body: unknown) => close.POST(new Request(`http://localhost/x`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const transferCall = (id: string, body: unknown) => transfer.POST(new Request(`http://localhost/x`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const json = async (r: Response) => (await r.json()) as any

const META_CH = { id: META, user_id: 'OWNER', provider: 'meta', phone_number_id: 'PN', access_token: 'tok', waba_id: 'W1', display_phone_number: '+55 27 99999-1212', waha_session: null, waha_url: null, waha_api_key: null, team_id: null, account_id: A, habilitado: true }
const WAHA_CH = { id: WAHA, user_id: 'OWNER', provider: 'waha', phone_number_id: null, access_token: null, waba_id: null, display_phone_number: null, waha_session: 'sess1', waha_url: 'https://waha.x', waha_api_key: 'k', team_id: null, account_id: A, habilitado: true }
const TPL = { id: 't1', account_id: A, name: 'lembrete', language: 'pt_BR', category: 'Utility', status: 'APPROVED', waba_id: 'W1', body_text: 'Olá {{1}}', header_type: null, header_content: null, buttons: null }

beforeEach(() => {
  Object.assign(h, { scopes: ['conversations:write'], createdBy: null, rate: true, seq: 0, sent: [], endedRuns: [], audit: [], providerCalled: 0, ledgerReleased: 0, blocked: [], red: [], sendError: null })
  h.db = {
    profiles: [
      { user_id: AGENT, account_id: A, full_name: 'Ana Souza', account_role: 'agent', deactivated_at: null },
      { user_id: AGENT2, account_id: A, full_name: 'Beto', account_role: 'supervisor', deactivated_at: null },
      { user_id: U(3), account_id: A, full_name: 'Visitante', account_role: 'viewer', deactivated_at: null },
      { user_id: U(4), account_id: 'ACC-B', full_name: 'Outra conta', account_role: 'agent', deactivated_at: null },
    ],
    teams: [{ id: TEAM, account_id: A, name: 'Cobrança' }, { id: U(12), account_id: 'ACC-B', name: 'Outra' }],
    contacts: [{ id: CONTACT, account_id: A, phone: '5527999991212', name: 'Carlos' }],
    whatsapp_config: [META_CH],
    conversations: [],
    conversation_assignments: [],
    agent_pauses: [],
    tags: [
      { id: TAB, account_id: A, name: 'Acordo Realizado', kind: 'outcome', codigo_tabulacao: 142 },
      { id: U(52), account_id: A, name: 'Sem interesse', kind: 'outcome', codigo_tabulacao: 7 },
      { id: U(53), account_id: A, name: 'Etiqueta', kind: 'contact', codigo_tabulacao: null },
      { id: U(54), account_id: 'ACC-B', name: 'Outra', kind: 'outcome', codigo_tabulacao: 142 },
    ],
    contact_notes: [],
    messages: [],
    message_templates: [TPL],
    accounts: [{ id: A, owner_user_id: 'OWNER-1' }],
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const conv = (over: Row = {}): Row => ({ id: CONV, account_id: A, contact_id: CONTACT, status: 'open', assigned_agent_id: null, team_id: null, config_id: META, waha_session: null, outcome_tag_id: null, closed_at: null, channel_type: 'whatsapp', ...over })

describe('POST /conversations (abrir)', () => {
  it('com atendente: cria conversa open atribuída; 201 created:true; sem mensagem não pede Idempotency-Key', async () => {
    const res = await open({ phone: '+5527999991212', assignee_id: AGENT })
    expect(res.status).toBe(201)
    const body = (await json(res)).data
    expect(body.conversation).toMatchObject({ status: 'open', assignee_id: AGENT, contact_id: CONTACT, created: true, channel: { id: META } })
    expect(body.transferred).toBe(false)
    expect(h.db.conversations[0]).toMatchObject({ account_id: A, user_id: 'OWNER', config_id: META, status: 'open', assigned_agent_id: AGENT })
  })

  it('só equipe: conversa pending na fila da equipe; sem nada: pending na fila da conta', async () => {
    const t = await json(await open({ phone: '+5527999991212', team_id: TEAM }))
    expect(t.data.conversation).toMatchObject({ status: 'pending', team_id: TEAM, assignee_id: null })
    h.db.conversations = []
    const none = await json(await open({ contact_id: CONTACT }))
    expect(none.data.conversation).toMatchObject({ status: 'pending', assignee_id: null, created: true })
  })

  it('contato novo é criado pelo telefone (nome padrão = telefone); contato de outra conta = 404', async () => {
    const res = await open({ phone: '+5511988880000', name: 'Dora' })
    expect(res.status).toBe(201)
    expect(h.db.contacts.find((c) => c.phone === '5511988880000')).toMatchObject({ account_id: A, name: 'Dora' })
    h.db.contacts.push({ id: U(22), account_id: 'ACC-B', phone: '5521977770000', name: 'x' })
    expect((await open({ contact_id: U(22) })).status).toBe(404)
  })

  it('atendente/equipe de outra conta, visualizador ou inexistente = 404; telefone inválido e corpo = 400', async () => {
    expect((await open({ phone: '+5527999991212', assignee_id: U(4) })).status).toBe(404)
    expect((await open({ phone: '+5527999991212', assignee_id: U(3) })).status).toBe(404)
    expect((await open({ phone: '+5527999991212', team_id: U(12) })).status).toBe(404)
    for (const body of [{}, { phone: '123' }, { phone: '+5527999991212', contact_id: CONTACT }, { phone: '+5527999991212', foo: 1 }, { phone: '+5527999991212', assignee_id: null }, { phone: '+5527999991212', message: {} }, { phone: '+5527999991212', message: { text: 'a', template: { name: 'x' } } }]) {
      expect((await open(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(h.db.conversations).toHaveLength(0)
  })

  it('atendente em PAUSA: 409 agent_paused sem criar nada; com confirm_paused atribui', async () => {
    h.db.agent_pauses.push({ user_id: AGENT, reason_name: 'Almoço', started_at: '2026-10-15T15:00:00Z', ended_at: null })
    const res = await open({ phone: '+5527999991212', assignee_id: AGENT })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toMatchObject({ code: 'conflict', reason: 'agent_paused', agent: { id: AGENT, name: 'Ana Souza' }, pause: { reason: 'Almoço' } })
    expect(h.db.conversations).toHaveLength(0)
    const ok = await open({ phone: '+5527999991212', assignee_id: AGENT, confirm_paused: true })
    expect(ok.status).toBe(201)
    expect(h.db.conversations[0].assigned_agent_id).toBe(AGENT)
  })

  it('já existe atendimento aberto: mesmo atendente = 200 created:false; outro = 409 conversation_exists; force_transfer transfere', async () => {
    h.db.conversations = [conv({ assigned_agent_id: AGENT })]
    const same = await open({ phone: '+5527999991212', assignee_id: AGENT })
    expect(same.status).toBe(200)
    expect((await json(same)).data.conversation).toMatchObject({ id: CONV, created: false })
    const nothing = await open({ phone: '+5527999991212' })
    expect(nothing.status).toBe(200)
    const other = await open({ phone: '+5527999991212', assignee_id: AGENT2 })
    expect(other.status).toBe(409)
    expect((await json(other)).error).toMatchObject({ reason: 'conversation_exists', conversation: { id: CONV, assignee_id: AGENT } })
    const forced = await open({ phone: '+5527999991212', assignee_id: AGENT2, force_transfer: true, reason: 'repasse' })
    expect(forced.status).toBe(200)
    const data = (await json(forced)).data
    expect(data).toMatchObject({ transferred: true, conversation: { assignee_id: AGENT2, created: false } })
    expect(h.db.conversations).toHaveLength(1)
  })

  it('force_transfer para atendente em pausa também exige confirm_paused', async () => {
    h.db.conversations = [conv({ assigned_agent_id: AGENT })]
    h.db.agent_pauses.push({ user_id: AGENT2, reason_name: 'Banheiro', started_at: '2026-10-15T15:00:00Z', ended_at: null })
    expect((await open({ phone: '+5527999991212', assignee_id: AGENT2, force_transfer: true })).status).toBe(409)
    expect(h.db.conversations[0].assigned_agent_id).toBe(AGENT)
  })

  it('conversa encerrada não conta: abre uma nova', async () => {
    h.db.conversations = [conv({ status: 'closed', assigned_agent_id: AGENT })]
    const res = await open({ phone: '+5527999991212', assignee_id: AGENT })
    expect(res.status).toBe(201)
    expect(h.db.conversations).toHaveLength(2)
  })

  it('canal: sem channel e 2 canais = 400; por número Meta e por sessão WAHA', async () => {
    h.db.whatsapp_config = [META_CH, WAHA_CH]
    expect((await open({ phone: '+5527999991212' })).status).toBe(400)
    const meta = await json(await open({ phone: '+5527999991212', channel: '5527999991212' }))
    expect(meta.data.conversation.channel.id).toBe(META)
    h.db.conversations = []
    const waha = await json(await open({ phone: '+5527999991212', channel: 'sess1' }))
    expect(waha.data.conversation.channel).toEqual({ id: null, waha_session: 'sess1' })
    expect((await open({ phone: '+5527999991212', channel: 'nao-existe' })).status).toBe(400)
  })

  describe('mensagem inicial', () => {
    it('exige Idempotency-Key (400, nada criado)', async () => {
      const res = await open({ phone: '+5527999991212', message: { text: 'oi' } })
      expect(res.status).toBe(400)
      expect(h.db.conversations).toHaveLength(0)
    })

    it('template Meta: valida o catálogo, envia, grava a mensagem renderizada e atualiza a conversa', async () => {
      const res = await open({ phone: '+5527999991212', assignee_id: AGENT, message: { template: { name: 'lembrete', variables: ['Carlos'] } } }, idem)
      expect(res.status).toBe(201)
      const data = (await json(res)).data
      expect(data.message).toMatchObject({ kind: 'template', whatsapp_message_id: 'wamid.tpl', saved: true })
      expect(h.sent[0]).toMatchObject({ kind: 'meta-template', phoneNumberId: 'PN', templateName: 'lembrete', language: 'pt_BR', params: ['Carlos'], accessToken: 'dec:tok' })
      expect(h.db.messages[0]).toMatchObject({ sender_type: 'bot', origin: 'api', content_type: 'template', content_text: 'Olá Carlos' })
      expect(h.db.conversations[0].last_message_text).toBe('Olá Carlos')
      expect(h.providerCalled).toBe(1)
    })

    it('validações antes de criar a conversa: template inexistente/variáveis/blacklist/vermelho', async () => {
      const call = (message: unknown) => open({ phone: '+5527999991212', message }, idem)
      expect((await call({ template: { name: 'nao_existe' } })).status).toBe(422)
      expect((await call({ template: { name: 'lembrete', variables: [] } })).status).toBe(400)
      h.blocked = [{ key: '27999991212' }]
      const blocked = await call({ template: { name: 'lembrete', variables: ['a'] } })
      expect(blocked.status).toBe(422)
      expect((await json(blocked)).error.code).toBe('recipient_blocked')
      h.blocked = []
      h.red = [{ id: META, display_phone_number: '+55 27 99999-1212' }]
      const red = await call({ template: { name: 'lembrete', variables: ['a'] } })
      expect(red.status).toBe(409)
      expect((await json(red)).error.reason).toBe('red_quality_owner_required')
      expect(h.db.conversations).toHaveLength(0)
      expect(h.sent).toHaveLength(0)
      expect(h.providerCalled).toBe(0)
    })

    it('texto livre na Meta: só com mensagem do cliente nas últimas 24h; senão 422 window_closed (conversa NÃO é criada)', async () => {
      const closed = await open({ phone: '+5527999991212', message: { text: 'oi' } }, idem)
      expect(closed.status).toBe(422)
      expect((await json(closed)).error).toMatchObject({ code: 'unprocessable', reason: 'window_closed' })
      expect(h.db.conversations).toHaveLength(0)
      h.db.conversations = [conv({ status: 'closed' })]
      h.db.messages = [{ id: 'm1', conversation_id: CONV, sender_type: 'customer', created_at: new Date(Date.now() - 3600_000).toISOString() }]
      const openWindow = await open({ phone: '+5527999991212', message: { text: 'oi' } }, idem)
      expect(openWindow.status).toBe(201)
      expect(h.sent[0]).toMatchObject({ kind: 'meta-text', text: 'oi' })
      h.db.messages = [{ id: 'm2', conversation_id: CONV, sender_type: 'customer', created_at: new Date(Date.now() - 30 * 3600_000).toISOString() }]
      expect((await open({ phone: '+5527999991212', message: { text: 'oi de novo' } }, idem)).status).toBe(422)
    })

    it('WAHA: texto sempre; template = 422', async () => {
      h.db.whatsapp_config = [WAHA_CH]
      const res = await open({ phone: '+5527999991212', message: { text: 'Olá' } }, idem)
      expect(res.status).toBe(201)
      expect(h.sent[0]).toMatchObject({ kind: 'waha-text', phone: '5527999991212', text: 'Olá', cfg: { waha_session: 'sess1', waha_api_key: 'dec:k' } })
      expect((await open({ phone: '+5527999991212', message: { template: { name: 'lembrete' } } }, idem)).status).toBe(422)
    })

    it('erro da Meta: 502 com meta_code, a chave NÃO é liberada (já houve chamada) e a conversa fica aberta', async () => {
      h.sendError = new MetaApiError('(#132001) Template não existe', 132001, 400)
      const res = await open({ phone: '+5527999991212', message: { template: { name: 'lembrete', variables: ['a'] } } }, idem)
      expect(res.status).toBe(502)
      expect((await json(res)).error).toMatchObject({ meta_code: 132001 })
      expect(h.providerCalled).toBe(1)
      expect(h.ledgerReleased).toBe(0)
      expect(h.db.conversations).toHaveLength(1)
    })

    it('gravação local falha depois do envio: resposta 201 com message.saved:false (não reenviar)', async () => {
      const orig = (Q.prototype as any).run
      ;(Q.prototype as any).run = function () {
        if ((this as any).table === 'messages' && (this as any).op === 'insert') return { data: null, error: { message: 'x' } }
        return orig.call(this)
      }
      try {
        const res = await open({ phone: '+5527999991212', message: { template: { name: 'lembrete', variables: ['a'] } } }, idem)
        expect(res.status).toBe(201)
        expect((await json(res)).data.message).toMatchObject({ saved: false, whatsapp_message_id: 'wamid.tpl' })
      } finally {
        ;(Q.prototype as any).run = orig
      }
    })
  })

  it('sem escopo conversations:write = 403; limite = 429', async () => {
    h.scopes = ['conversations:read']
    expect((await open({ phone: '+5527999991212' })).status).toBe(403)
    h.scopes = ['conversations:write']
    h.rate = false
    expect((await open({ phone: '+5527999991212' })).status).toBe(429)
  })
})

describe('carteira fixa ao abrir (fase 1)', () => {
  beforeEach(() => {
    h.db.contacts[0].owner_user_id = AGENT
  })

  it('sem atendente nem equipe: vai para o DONO do contato (via_owner: true)', async () => {
    const res = await open({ phone: '+5527999991212' })
    expect(res.status).toBe(201)
    const data = (await json(res)).data
    expect(data).toMatchObject({ via_owner: true, conversation: { status: 'open', assignee_id: AGENT, created: true } })
    expect(h.db.conversations[0].assigned_agent_id).toBe(AGENT)
  })

  it('dono em pausa, desativado ou que deixou de atender: cai na fila (pending), sem erro', async () => {
    h.db.agent_pauses.push({ user_id: AGENT, reason_name: 'Almoço', started_at: '2026-10-15T15:00:00Z', ended_at: null })
    const paused = await json(await open({ phone: '+5527999991212' }))
    expect(paused.data).toMatchObject({ via_owner: false, conversation: { status: 'pending', assignee_id: null } })
    h.db.conversations = []
    h.db.agent_pauses = []
    h.db.profiles[0].deactivated_at = '2026-02-01'
    const off = await json(await open({ phone: '+5527999991212' }))
    expect(off.data).toMatchObject({ via_owner: false, conversation: { status: 'pending', assignee_id: null } })
  })

  it('atendente OU equipe pedidos vencem o dono; conversa já aberta não é redirecionada', async () => {
    const team = await json(await open({ phone: '+5527999991212', team_id: TEAM }))
    expect(team.data).toMatchObject({ via_owner: false, conversation: { assignee_id: null, team_id: TEAM } })
    h.db.conversations = []
    const explicit = await json(await open({ phone: '+5527999991212', assignee_id: AGENT2 }))
    expect(explicit.data).toMatchObject({ via_owner: false, conversation: { assignee_id: AGENT2 } })
    const again = await open({ phone: '+5527999991212' })
    expect(again.status).toBe(200)
    expect((await json(again)).data).toMatchObject({ via_owner: false, conversation: { assignee_id: AGENT2, created: false } })
  })

  it('contato sem dono: fila, como antes', async () => {
    h.db.contacts[0].owner_user_id = null
    expect((await json(await open({ phone: '+5527999991212' }))).data).toMatchObject({ via_owner: false, conversation: { status: 'pending' } })
  })
})

describe('POST /conversations/{id}/transfer', () => {
  beforeEach(() => {
    h.db.conversations = [conv({ assigned_agent_id: AGENT, status: 'open' })]
  })

  it('transfere, completa o histórico (ator = quem criou a chave, motivo) e registra a origem API na auditoria', async () => {
    h.createdBy = KEY_CREATOR
    const res = await transferCall(CONV, { assignee_id: AGENT2, team_id: TEAM, reason: 'cliente pediu' })
    expect(res.status).toBe(200)
    expect((await json(res)).data).toMatchObject({ changed: true, conversation: { assignee_id: AGENT2, team_id: TEAM } })
    expect(h.db.conversation_assignments[0]).toMatchObject({ actor_id: KEY_CREATOR, reason: 'cliente pediu' })
    expect(h.audit[0]).toEqual({ actorType: 'api', source: 'api_v1', note: 'cliente pediu' })
  })

  it('null remove o atendente; repetir sem mudança = changed:false', async () => {
    const removed = await transferCall(CONV, { assignee_id: null })
    expect((await json(removed)).data).toMatchObject({ changed: true, conversation: { assignee_id: null } })
    const again = await transferCall(CONV, { assignee_id: null })
    expect((await json(again)).data.changed).toBe(false)
    expect(h.db.conversation_assignments).toHaveLength(1)
  })

  it('atendente em pausa: 409 agent_paused (nada muda); confirm_paused atribui e marca o motivo', async () => {
    h.db.agent_pauses.push({ user_id: AGENT2, reason_name: 'Almoço', started_at: '2026-10-15T15:00:00Z', ended_at: null })
    const res = await transferCall(CONV, { assignee_id: AGENT2 })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toMatchObject({ code: 'conflict', reason: 'agent_paused', agent: { id: AGENT2, name: 'Beto' }, pause: { reason: 'Almoço' } })
    expect(h.db.conversations[0].assigned_agent_id).toBe(AGENT)
    const ok = await transferCall(CONV, { assignee_id: AGENT2, confirm_paused: true, reason: 'urgente' })
    expect(ok.status).toBe(200)
    expect(h.db.conversation_assignments[0].reason).toBe('(atendente em pausa, confirmado) urgente')
  })

  it('encerrada = 409 conversation_closed; outra conta/id ruim = 404; sem alvo = 400; atendente inválido = 404', async () => {
    h.db.conversations[0].status = 'closed'
    const closed = await transferCall(CONV, { assignee_id: AGENT2 })
    expect(closed.status).toBe(409)
    expect((await json(closed)).error.reason).toBe('conversation_closed')
    h.db.conversations[0].status = 'open'
    h.db.conversations[0].account_id = 'ACC-B'
    expect((await transferCall(CONV, { assignee_id: AGENT2 })).status).toBe(404)
    h.db.conversations[0].account_id = A
    expect((await transferCall('abc', { assignee_id: AGENT2 })).status).toBe(404)
    expect((await transferCall(CONV, {})).status).toBe(400)
    expect((await transferCall(CONV, { assignee_id: U(4) })).status).toBe(404)
    expect((await transferCall(CONV, { team_id: U(12) })).status).toBe(404)
  })

  it('sem escopo = 403', async () => {
    h.scopes = ['conversations:read']
    expect((await transferCall(CONV, { assignee_id: AGENT2 })).status).toBe(403)
  })
})

describe('POST /conversations/{id}/close', () => {
  beforeEach(() => {
    h.db.conversations = [conv({ assigned_agent_id: AGENT })]
  })

  it('encerra com a tabulação por código: outcome_source automation, fluxo ativo encerrado, nota do contato gravada', async () => {
    h.createdBy = KEY_CREATOR
    const res = await closeCall(CONV, { tabulation_code: 142, note: 'Acordo em 3x' })
    expect(res.status).toBe(200)
    const data = (await json(res)).data
    expect(data).toMatchObject({ changed: true, conversation: { id: CONV, status: 'closed', outcome: { id: TAB, code: 142, name: 'Acordo Realizado' } } })
    expect(data.conversation.closed_at).toBeTruthy()
    expect(h.db.conversations[0]).toMatchObject({ status: 'closed', outcome_tag_id: TAB, outcome_source: 'automation', outcome_set_by: KEY_CREATOR })
    expect(h.endedRuns).toEqual([CONV])
    expect(h.db.contact_notes[0]).toMatchObject({ contact_id: CONTACT, account_id: A, user_id: KEY_CREATOR, note_text: '[Encerramento pela API] Acordo em 3x' })
  })

  it('por id; sem chave criadora a nota é do dono da conta; tabulação de contato/outra conta = 404', async () => {
    h.db.accounts = [{ id: A, owner_user_id: 'OWNER-1' }]
    const byId = await closeCall(CONV, { tabulation_id: U(52), note: 'x' })
    expect(byId.status).toBe(200)
    expect(h.db.contact_notes[0].user_id).toBe('OWNER-1')
    h.db.conversations[0].status = 'open'
    expect((await closeCall(CONV, { tabulation_id: U(53) })).status).toBe(404) // etiqueta de contato
    expect((await closeCall(CONV, { tabulation_id: U(54) })).status).toBe(404) // outra conta
    expect((await closeCall(CONV, { tabulation_code: 999 })).status).toBe(404)
  })

  it('idempotente: mesma tabulação = changed:false (sem nota nem fluxo de novo); outra = 409 already_closed', async () => {
    await closeCall(CONV, { tabulation_code: 142, note: 'a' })
    h.endedRuns = []
    const again = await closeCall(CONV, { tabulation_code: 142, note: 'b' })
    expect((await json(again)).data.changed).toBe(false)
    expect(h.endedRuns).toEqual([])
    expect(h.db.contact_notes).toHaveLength(1)
    const other = await closeCall(CONV, { tabulation_code: 7 })
    expect(other.status).toBe(409)
    expect((await json(other)).error.reason).toBe('already_closed')
  })

  it('validações: sem tabulação, as duas juntas, código não inteiro, nota longa, conversa de outra conta, escopo', async () => {
    for (const body of [{}, { tabulation_code: 142, tabulation_id: TAB }, { tabulation_code: '142' }, { tabulation_code: 142, note: 'x'.repeat(1001) }, { tabulation_code: 142, foo: 1 }]) {
      expect((await closeCall(CONV, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await closeCall('abc', { tabulation_code: 142 })).status).toBe(404)
    h.db.conversations[0].account_id = 'ACC-B'
    expect((await closeCall(CONV, { tabulation_code: 142 })).status).toBe(404)
    h.db.conversations[0].account_id = A
    h.scopes = ['conversations:read']
    expect((await closeCall(CONV, { tabulation_code: 142 })).status).toBe(403)
    expect(h.db.conversations[0].status).toBe('open')
  })
})
