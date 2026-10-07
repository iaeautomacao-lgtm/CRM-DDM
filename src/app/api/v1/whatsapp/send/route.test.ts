import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'

// ---------------------------------------------------------------------------
// POST /api/v1/whatsapp/send — waha_api_key decifrada, blacklist (422), JSON
// inválido (400) e liberação da Idempotency-Key em erro pré-provedor.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  config: null as Record<string, any> | null,
  blocked: [] as Array<{ key: string }>,
  rpcError: null as { message: string } | null,
  providerCalls: [] as Array<{ fn: string; args: any[] }>,
  ledgerReleased: 0,
  providerCalledFlag: false,
  failMeta: false,
}))

function chain(table: string) {
  const b: any = {}
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'insert']) b[m] = () => b
  const row = () => {
    if (table === 'whatsapp_config') return state.config
    if (table === 'messages') return { id: 'MSG-1' }
    if (table === 'conversations') return { id: 'CONV-1' }
    return null
  }
  b.single = async () => ({ data: row(), error: null })
  b.maybeSingle = async () => ({ data: row(), error: null })
  b.then = (resolve: (v: unknown) => void) =>
    resolve({ data: table === 'conversations' ? [{ id: 'CONV-1' }] : [], error: null })
  return b
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    accountId: 'ACC',
    keyId: 'KEY',
    scopes: ['messages:send'],
    supabase: {
      rpc: async () => ({ data: state.rpcError ? null : state.blocked, error: state.rpcError }),
      from: (t: string) => chain(t),
    },
  }),
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/storage/provider-media', () => ({ resolveProviderMedia: async (u: string) => u }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: async () => ({ id: 'CONTACT-1', name: 'Ana' }),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: async (...a: any[]) => {
    if (state.failMeta) throw new Error('boom')
    state.providerCalls.push({ fn: 'meta', args: a })
    return { messageId: 'wamid.meta' }
  },
  sendMediaMessage: vi.fn(),
  uploadMedia: vi.fn(),
}))
vi.mock('@/lib/whatsapp/waha-api', () => ({
  sendWahaTextMessage: async (...a: any[]) => (state.providerCalls.push({ fn: 'waha', args: a }), { messageId: 'waha-1' }),
  sendWahaMediaMessage: vi.fn(),
  sendWahaVoiceMessage: vi.fn(),
  sendWahaMediaMessageBase64: vi.fn(),
  sendWahaVoiceMessageBase64: vi.fn(),
}))
// Ledger real simulado: reserva sempre nova; libera se falhar antes do provedor.
vi.mock('@/lib/disparador/send-ledger', () => ({
  runIdempotentSend: async (_a: string, _r: Request, work: (ctl: any) => Promise<Response>) => {
    let called = false
    try {
      return await work({ providerCalled: () => (called = true, (state.providerCalledFlag = true)) })
    } catch (err) {
      if (!called) state.ledgerReleased++
      throw err
    }
  },
}))

const { POST } = await import('./route')

function req(body: unknown, raw?: string): Request {
  return new Request('http://localhost/api/v1/whatsapp/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'cobranca-0001' },
    body: raw ?? JSON.stringify(body),
  })
}

describe('POST /api/v1/whatsapp/send', () => {
  beforeEach(() => {
    state.config = { id: 'CFG', provider: 'meta', user_id: 'U', phone_number_id: 'PN', access_token: encrypt('meta-token') }
    state.blocked = []
    state.rpcError = null
    state.providerCalls = []
    state.ledgerReleased = 0
    state.providerCalledFlag = false
    state.failMeta = false
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('envia no canal Meta quando o número não está bloqueado', async () => {
    const res = await POST(req({ phone: '+5527999991212', text: 'Olá' }))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ success: true, whatsapp_message_id: 'wamid.meta' })
    expect(state.providerCalls[0].fn).toBe('meta')
  })

  it('WAHA: usa a waha_api_key DECIFRADA (cifrada no banco)', async () => {
    state.config = {
      id: 'CFG',
      provider: 'waha',
      user_id: 'U',
      waha_url: 'https://waha.example.com',
      waha_session: 'default',
      waha_api_key: encrypt('chave-waha-em-claro'),
    }
    const res = await POST(req({ phone: '+5527999991212', text: 'Olá' }))
    expect(res.status).toBe(200)
    const [wahaConfig] = state.providerCalls[0].args
    expect(state.providerCalls[0].fn).toBe('waha')
    expect(wahaConfig.waha_api_key).toBe('chave-waha-em-claro')
  })

  it('WAHA: chave legada em texto puro continua funcionando', async () => {
    state.config = { id: 'CFG', provider: 'waha', user_id: 'U', waha_url: 'https://w', waha_session: 's', waha_api_key: 'plain-key' }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(req({ phone: '+5527999991212', text: 'Olá' }))
    expect(res.status).toBe(200)
    expect(state.providerCalls[0].args[0].waha_api_key).toBe('plain-key')
  })

  it('blacklist/opt-out: 422 recipient_blocked sem chamar o provedor e sem consumir a chave', async () => {
    state.blocked = [{ key: '27999991212' }]
    const res = await POST(req({ phone: '+5527999991212', text: 'Olá' }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatchObject({ code: 'recipient_blocked' })
    expect(state.providerCalls).toHaveLength(0)
    expect(state.providerCalledFlag).toBe(false)
    expect(state.ledgerReleased).toBe(1)
  })

  it('falha ao consultar a blacklist fecha: 503 unavailable, nada enviado', async () => {
    state.rpcError = { message: 'down' }
    const res = await POST(req({ phone: '+5527999991212', text: 'Olá' }))
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('unavailable')
    expect(state.providerCalls).toHaveLength(0)
  })

  it('JSON inválido → 400 (não 500) e libera a reserva', async () => {
    const res = await POST(req(null, '{nao-json'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
    expect(state.ledgerReleased).toBe(1)
    expect(state.providerCalls).toHaveLength(0)
  })

  it('400 de validação libera a reserva; corrigido e reenviado com a mesma chave, envia', async () => {
    const bad = await POST(req({ phone: '+5527999991212' })) // sem texto nem mídia
    expect(bad.status).toBe(400)
    expect(state.ledgerReleased).toBe(1)
    expect(state.providerCalls).toHaveLength(0)

    const fixed = await POST(req({ phone: '+5527999991212', text: 'Agora com texto' }))
    expect(fixed.status).toBe(200)
    expect(state.providerCalls).toHaveLength(1)
  })

  it('erro do provedor (502) NÃO libera a reserva (resultado incerto)', async () => {
    state.failMeta = true
    const res = await POST(req({ phone: '+5527999991212', text: 'Olá' }))
    expect(res.status).toBe(502)
    expect(state.providerCalledFlag).toBe(true)
    expect(state.ledgerReleased).toBe(0)
  })
})
