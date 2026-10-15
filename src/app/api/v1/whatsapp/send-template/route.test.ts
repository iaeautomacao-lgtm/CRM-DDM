import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'

// POST /api/v1/whatsapp/send-template — canal Meta × WAHA, validações antes da Meta, blacklist, qualidade vermelha, limite 60/min,
// salvar_bd, 202 de reconciliação, erro da Meta (502 com meta_code) e liberação da Idempotency-Key só antes do provedor.

const state = vi.hoisted(() => ({
  scopes: ['messages:send'] as string[],
  channels: [] as Array<Record<string, any>>,
  templates: [] as Array<Record<string, any>>,
  blocked: [] as Array<{ key: string }>,
  rpcError: null as { message: string } | null,
  red: [] as Array<{ id: string; display_phone_number: string | null }>,
  rate: true,
  sent: [] as any[],
  sendError: null as unknown,
  insertedMessages: [] as any[],
  messageInsertFails: false,
  conversationUpdates: [] as any[],
  ledgerReleased: 0,
  providerCalled: false,
}))

function chain(table: string) {
  const b: any = {}
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) b[m] = () => b
  b.insert = (row: any) => {
    if (table === 'messages') state.insertedMessages.push(row)
    return b
  }
  b.update = (row: any) => {
    if (table === 'conversations') state.conversationUpdates.push(row)
    return b
  }
  const rows = () => (table === 'whatsapp_config' ? state.channels : table === 'message_templates' ? state.templates : [])
  b.single = async () =>
    table === 'messages'
      ? state.messageInsertFails
        ? { data: null, error: { message: 'x' } }
        : { data: { id: 'MSG-1' }, error: null }
      : { data: { id: 'NEW' }, error: null }
  b.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null })
  return b
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async (_r: Request, scope: string | string[]) => {
    const needed = Array.isArray(scope) ? scope : [scope]
    if (!needed.some((s) => state.scopes.includes(s))) {
      const { forbidden } = await import('@/lib/api/v1/respond')
      throw forbidden('sem escopo')
    }
    return {
      accountId: 'ACC',
      keyId: 'KEY',
      scopes: state.scopes,
      supabase: { rpc: async () => ({ data: state.rpcError ? null : state.blocked, error: state.rpcError }), from: (t: string) => chain(t) },
    }
  },
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: async () => ({ success: state.rate, limit: 60, remaining: 0, reset: Date.now() + 30_000 }),
}))
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: async () => ({ id: 'CONTACT-1', name: 'Ana' }), isUniqueViolation: () => false }))
vi.mock('@/lib/api/v1/conversation-open', () => ({ findOrCreateConversation: async () => ({ id: 'CONV-1' }) }))
vi.mock('@/lib/disparador/red-quality-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/disparador/red-quality-gate')>()),
  findRedChannels: async () => state.red,
}))
vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: async (args: any) => {
    state.sent.push(args)
    if (state.sendError) throw state.sendError
    return { messageId: 'wamid.tpl' }
  },
}))
vi.mock('@/lib/disparador/send-ledger', () => ({
  runIdempotentSend: async (_a: string, _r: Request, work: (ctl: any) => Promise<Response>) => {
    let called = false
    try {
      return await work({ providerCalled: () => ((called = true), (state.providerCalled = true)) })
    } catch (err) {
      if (!called) state.ledgerReleased++
      throw err
    }
  },
}))

const { POST } = await import('./route')
const { MetaApiError } = await import('@/lib/whatsapp/meta-api')

const META = { id: '5b0e5a64-0000-4000-8000-000000000011', user_id: 'U', provider: 'meta', phone_number_id: 'PN', access_token: encrypt('meta-token'), waba_id: 'WABA1', display_phone_number: '+55 27 99999-1212' }
const WAHA = { id: '5b0e5a64-0000-4000-8000-000000000012', user_id: 'U', provider: 'waha', phone_number_id: null, access_token: null, waba_id: null, display_phone_number: null, waha_session: 's1' }
const TPL = { id: 't1', name: 'lembrete', language: 'pt_BR', category: 'Utility', status: 'APPROVED', waba_id: 'WABA1', body_text: 'Olá {{1}}, vence {{2}}.', header_type: null, header_content: null, buttons: null }

const body = (over: Record<string, unknown> = {}) => ({ to: '+5527999991212', template: { name: 'lembrete', language: 'pt_BR' }, variables: ['Ana', 'amanhã'], ...over })
const req = (b: unknown, raw?: string) =>
  new Request('http://localhost/api/v1/whatsapp/send-template', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'lembrete-0001' },
    body: raw ?? JSON.stringify(b),
  })

beforeEach(() => {
  Object.assign(state, {
    scopes: ['messages:send'],
    channels: [META],
    templates: [TPL],
    blocked: [],
    rpcError: null,
    red: [],
    rate: true,
    sent: [],
    sendError: null,
    insertedMessages: [],
    messageInsertFails: false,
    conversationUpdates: [],
    ledgerReleased: 0,
    providerCalled: false,
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/v1/whatsapp/send-template', () => {
  it('envia o template, grava mensagem (bot/api/template, texto renderizado) e devolve o formato da spec', async () => {
    const res = await POST(req(body()))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      message_id: 'MSG-1',
      whatsapp_message_id: 'wamid.tpl',
      conversation_id: 'CONV-1',
      contact_id: 'CONTACT-1',
      channel: { id: META.id, label: '+55 27 99999-1212' },
      template: { name: 'lembrete', language: 'pt_BR', category: 'UTILITY' },
      status: 'accepted',
      saved: true,
    })
    expect(state.sent[0]).toMatchObject({ phoneNumberId: 'PN', accessToken: 'meta-token', templateName: 'lembrete', language: 'pt_BR', params: ['Ana', 'amanhã'] })
    expect(state.insertedMessages[0]).toMatchObject({ sender_type: 'bot', origin: 'api', content_type: 'template', content_text: 'Olá Ana, vence amanhã.', message_id: 'wamid.tpl' })
    expect(state.conversationUpdates[0]).toMatchObject({ last_message_text: 'Olá Ana, vence amanhã.' })
  })

  it('idioma omitido = pt_BR', async () => {
    const res = await POST(req(body({ template: { name: 'lembrete' } })))
    expect(res.status).toBe(200)
    expect(state.sent[0].language).toBe('pt_BR')
  })

  it('sem o escopo messages:send → 403', async () => {
    state.scopes = ['templates:read']
    expect((await POST(req(body()))).status).toBe(403)
    expect(state.sent).toHaveLength(0)
  })

  it('limite de 60/min por chave → 429 com Retry-After, nada enviado', async () => {
    state.rate = false
    const res = await POST(req(body()))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(state.sent).toHaveLength(0)
  })

  it('canal WAHA (único canal) → 422 unprocessable em português, sem chamar a Meta', async () => {
    state.channels = [WAHA]
    const res = await POST(req(body()))
    expect(res.status).toBe(422)
    const err = (await res.json()).error
    expect(err.code).toBe('unprocessable')
    expect(err.message).toMatch(/exclusivo de canal Meta.*\/whatsapp\/send/)
    expect(state.sent).toHaveLength(0)
    expect(state.ledgerReleased).toBe(1)
  })

  it('channel apontando para um canal WAHA → 422; para um número Meta → usa esse canal', async () => {
    const other = { ...META, id: '5b0e5a64-0000-4000-8000-000000000013', display_phone_number: '+55 11 98888-0000', phone_number_id: 'PN2' }
    state.channels = [META, WAHA, other]
    expect((await POST(req(body({ channel: WAHA.id })))).status).toBe(422)
    const res = await POST(req(body({ channel: '5511988880000' })))
    expect(res.status).toBe(200)
    expect(state.sent[0].phoneNumberId).toBe('PN2')
  })

  it('sem channel e mais de um canal Meta → 400', async () => {
    state.channels = [META, { ...META, id: '5b0e5a64-0000-4000-8000-000000000013' }]
    const res = await POST(req(body()))
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/informe 'channel'/)
  })

  it('template inexistente → 422; não aprovado → 422 dizendo o status', async () => {
    state.templates = []
    const missing = await POST(req(body()))
    expect(missing.status).toBe(422)
    expect((await missing.json()).error.message).toMatch(/não encontrado no catálogo/)
    state.templates = [{ ...TPL, status: 'PENDING' }]
    const pending = await POST(req(body()))
    expect(pending.status).toBe(422)
    expect((await pending.json()).error.message).toMatch(/não aprovado pela Meta \(status PENDING\)/)
    expect(state.sent).toHaveLength(0)
  })

  it('catálogo de outra WABA não vale (linha da WABA do canal é a que decide)', async () => {
    state.templates = [{ ...TPL, waba_id: 'OUTRA' }]
    expect((await POST(req(body()))).status).toBe(422)
  })

  it('nº de variáveis diferente do corpo → 400 (não consome a chave)', async () => {
    const res = await POST(req(body({ variables: ['Ana'] })))
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/espera 2 variável\(is\).*trouxe 1/)
    expect(state.ledgerReleased).toBe(1)
    expect(state.providerCalled).toBe(false)
  })

  it.each([
    ['cabeçalho de imagem', { header_type: 'image' }],
    ['botão de URL dinâmica', { buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] }],
    ['botão de copiar código', { buttons: [{ type: 'COPY_CODE' }] }],
    ['botão de Flow', { buttons: [{ type: 'FLOW' }] }],
  ])('%s → 422 unprocessable', async (_n, over) => {
    state.templates = [{ ...TPL, ...over }]
    const res = await POST(req(body()))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('unprocessable')
    expect(state.sent).toHaveLength(0)
  })

  it('telefone fora do E.164, JSON inválido e template ausente → 400', async () => {
    expect((await POST(req(body({ to: '123' })))).status).toBe(400)
    expect((await POST(req(null, '{ nao json'))).status).toBe(400)
    expect((await POST(req(body({ template: undefined })))).status).toBe(400)
    expect((await POST(req(body({ variables: 'Ana' })))).status).toBe(400)
    expect(state.sent).toHaveLength(0)
  })

  it('blacklist → 422 recipient_blocked; falha na checagem → 503; nada enviado', async () => {
    state.blocked = [{ key: '27999991212' }]
    const blocked = await POST(req(body()))
    expect(blocked.status).toBe(422)
    expect((await blocked.json()).error.code).toBe('recipient_blocked')
    state.blocked = []
    state.rpcError = { message: 'down' }
    expect((await POST(req(body()))).status).toBe(503)
    expect(state.sent).toHaveLength(0)
    expect(state.providerCalled).toBe(false)
  })

  it('canal em qualidade vermelha → 409 conflict com reason e channels', async () => {
    state.red = [{ id: META.id, display_phone_number: '+55 27 99999-1212' }]
    const res = await POST(req(body()))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatchObject({ code: 'conflict', reason: 'red_quality_owner_required', channels: [{ id: META.id, label: '+55 27 99999-1212' }] })
    expect(state.sent).toHaveLength(0)
  })

  it('erro da Meta → 502 com meta_code, e a Idempotency-Key NÃO é liberada', async () => {
    state.sendError = new MetaApiError('(#132001) Template não existe', 132001, 400)
    const res = await POST(req(body()))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatchObject({ code: 'internal', meta_code: 132001, meta_http_status: 400 })
    expect(state.providerCalled).toBe(true)
    expect(state.ledgerReleased).toBe(0)
    expect(state.insertedMessages).toHaveLength(0)
  })

  it('salvar_bd:false → envia sem gravar nada e responde saved:false', async () => {
    const res = await POST(req(body({ salvar_bd: false })))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ whatsapp_message_id: 'wamid.tpl', saved: false, status: 'accepted' })
    expect(state.insertedMessages).toHaveLength(0)
    expect(state.conversationUpdates).toHaveLength(0)
  })

  it('Meta aceitou e a gravação local falhou → 202 reconciliation_required (não reenviar)', async () => {
    state.messageInsertFails = true
    const res = await POST(req(body()))
    expect(res.status).toBe(202)
    expect((await res.json()).data).toMatchObject({ saved: false, reconciliation_required: true, whatsapp_message_id: 'wamid.tpl' })
  })

  it('não vaza o token da Meta em nenhuma resposta', async () => {
    const text = JSON.stringify(await (await POST(req(body()))).json())
    expect(text).not.toContain('meta-token')
    expect(text).not.toContain(META.access_token)
  })
})
