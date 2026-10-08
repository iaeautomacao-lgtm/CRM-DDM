// PRD 14, 14.10 — WAHA: teto de corpo (SW-5), alarme do segredo legado (SW-4) e idempotência atômica e por conta (SW-6).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  writeLog: vi.fn(async () => {}),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: mocks.admin }))
vi.mock('@/lib/audit/context', () => ({ registerAuditActor: vi.fn() }))
vi.mock('@/lib/logger', () => ({ writeLog: mocks.writeLog, maskPhone: (p: string) => p }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: async () => ({ consumed: true }) }))
vi.mock('@/lib/ai/sentiment-trigger', () => ({ maybeScheduleSentiment: () => undefined }))
vi.mock('@/lib/disparador/reply-tracker', () => ({ recordCampaignReply: async () => undefined }))
vi.mock('@/lib/webchat/campaign', () => ({ maybeStartCampaignWebchat: async () => false }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => undefined }))

import { POST } from './route'
import { __resetLegacyWahaReportsForTests, wahaChannelWebhookSecret } from '@/lib/whatsapp/waha-webhook-auth'

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const URL_BASE = 'https://crm.test/api/whatsapp/webhook/waha'
const SESSION = 'sessao-a'

type Call = { table: string; method: string; args: unknown[] }

/**
 * Banco falso do fluxo message.any: config do canal, contato e conversa já existentes, nenhuma mensagem gravada e o INSERT em
 * `messages` devolvendo o erro configurado (23505 = outra entrega ganhou a corrida).
 */
function fakeDb(opts: { insertError?: { code?: string; message: string } | null; existingMessage?: boolean } = {}) {
  const calls: Call[] = []
  const rows: Record<string, unknown[]> = {
    whatsapp_config: [{ id: CHANNEL, account_id: 'conta-a', waha_session: SESSION, provider: 'waha', user_id: 'u1' }],
    contacts: [{ id: 'c1', avatar_url: 'http://avatar', name: 'Ana', phone: '+5511999990001' }],
    conversations: [{ id: 'cv1', status: 'open', unread_count: 0, assigned_agent_id: null }],
  }
  const from = (table: string) => {
    let isInsert = false
    const resolveResult = () => {
      if (table === 'messages' && isInsert) return { data: null, error: opts.insertError ?? null }
      if (table === 'messages') return { data: opts.existingMessage ? [{ id: 'm-exists' }] : [], error: null }
      return { data: rows[table] ?? [], error: null }
    }
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => resolve(resolveResult()),
      maybeSingle: async () => {
        const r = resolveResult()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      },
      single: async () => ({ data: { id: 'new' }, error: null }),
    }
    for (const method of ['select', 'eq', 'in', 'limit', 'update', 'is', 'order', 'gte', 'lte']) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args })
        return builder
      }
    }
    builder.insert = (...args: unknown[]) => {
      isInsert = true
      calls.push({ table, method: 'insert', args })
      return builder
    }
    return builder
  }
  mocks.admin.mockReturnValue({ from, rpc: async () => ({ data: null, error: null }) })
  return calls
}

const messageAny = (id = 'false_5511999990001@c.us_ABC') =>
  JSON.stringify({
    event: 'message.any',
    session: SESSION,
    payload: { id, timestamp: 1_760_000_000, from: '5511999990001@c.us', to: '5511888880000@c.us', body: 'oi', fromMe: false, hasMedia: false, type: 'chat', chatId: '5511999990001@c.us' },
  })

const authed = (body: string, extra: Record<string, string> = {}) =>
  new Request(`${URL_BASE}?channel=${CHANNEL}`, {
    method: 'POST',
    headers: { 'x-webhook-secret': wahaChannelWebhookSecret(CHANNEL), ...extra },
    body,
  })

beforeEach(() => {
  vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret')
  __resetLegacyWahaReportsForTests()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('SW-5: teto de corpo e JSON inválido (depois da autenticação)', () => {
  it('corpo acima de 1 MB (Content-Length declarado) autenticado: 413 e nenhum cliente de banco criado', async () => {
    const res = await POST(authed('x', { 'content-length': String(2 * 1024 * 1024) }))
    expect(res.status).toBe(413)
    expect(mocks.admin).not.toHaveBeenCalled()
  })

  it('corpo gigante sem Content-Length: 413', async () => {
    const res = await POST(authed('a'.repeat(1_100_000)))
    expect(res.status).toBe(413)
    expect(mocks.admin).not.toHaveBeenCalled()
  })

  it('JSON inválido com segredo certo: 400 (não 500)', async () => {
    const res = await POST(authed('isto não é json'))
    expect(res.status).toBe(400)
  })

  it('sem autenticação nada é lido: segredo errado continua 401 mesmo com corpo gigante', async () => {
    const res = await POST(
      new Request(`${URL_BASE}?channel=${CHANNEL}`, { method: 'POST', headers: { 'x-webhook-secret': 'errado' }, body: 'a'.repeat(1_100_000) }),
    )
    expect(res.status).toBe(401)
  })
})

describe('SW-4: segredo global legado só com a flag e com alarme', () => {
  const legacy = () => new Request(URL_BASE, { method: 'POST', headers: { 'x-webhook-secret': 'test-secret' }, body: messageAny() })

  it('flag desligada (padrão): 401, sem consultar o banco', async () => {
    expect((await POST(legacy())).status).toBe(401)
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.writeLog).not.toHaveBeenCalled()
  })

  it('flag ligada: aceita, mas grava waha_legacy_secret_used (canal e sessão) — 1× por sessão a cada 10 min', async () => {
    vi.stubEnv('WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET', 'true')
    fakeDb({ insertError: { code: '23505', message: 'duplicate' } })
    expect((await POST(legacy())).status).toBe(200)
    expect(mocks.writeLog).toHaveBeenCalledTimes(1)
    expect(mocks.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'conta-a',
        level: 'warn',
        source: 'webhook_waha',
        event: 'waha_legacy_secret_used',
        payload: { channel_id: CHANNEL, session: SESSION },
      }),
    )
    await POST(legacy())
    expect(mocks.writeLog).toHaveBeenCalledTimes(1) // amostrado
  })

  it('com o segredo POR CANAL (?channel=) não há alarme', async () => {
    vi.stubEnv('WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET', 'true')
    fakeDb({ insertError: { code: '23505', message: 'duplicate' } })
    expect((await POST(authed(messageAny()))).status).toBe(200)
    expect(mocks.writeLog).not.toHaveBeenCalled()
  })
})

describe('SW-6: idempotência atômica e por conta', () => {
  it('a checagem de duplicata é escopada pela CONTA do canal autenticado', async () => {
    const calls = fakeDb({ insertError: { code: '23505', message: 'duplicate' } })
    await POST(authed(messageAny()))
    const lookups = calls.filter((c) => c.table === 'messages' && c.method === 'eq')
    expect(lookups).toContainEqual({ table: 'messages', method: 'eq', args: ['account_id', 'conta-a'] })
    expect(lookups).toContainEqual({ table: 'messages', method: 'eq', args: ['message_id', 'false_5511999990001@c.us_ABC'] })
  })

  it('corrida: o INSERT perde para outra entrega (23505) → 200 "já sincronizada", não 500 (o WAHA não reenvia em laço)', async () => {
    fakeDb({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint' } })
    const res = await POST(authed(messageAny()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, message: 'Message already synchronized' })
  })

  it('outro erro de banco no INSERT continua 500 (nada é engolido)', async () => {
    fakeDb({ insertError: { code: '57014', message: 'statement timeout' } })
    const res = await POST(authed(messageAny()))
    expect(res.status).toBe(500)
  })

  it('mensagem já gravada nesta conta: 200 sem inserir', async () => {
    const calls = fakeDb({ existingMessage: true })
    const res = await POST(authed(messageAny()))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe('Message already synchronized')
    expect(calls.some((c) => c.table === 'messages' && c.method === 'insert')).toBe(false)
  })
})
