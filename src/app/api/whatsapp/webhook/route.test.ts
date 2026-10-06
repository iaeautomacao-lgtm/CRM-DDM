import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { clearAppSecretCache } from '@/lib/whatsapp/webhook-fast-path'

// ---------------------------------------------------------------------------
// Verificação de assinatura do webhook Meta com app_secret por canal:
// cifrado (formato atual) e texto puro legado (gravado direto no banco antes
// da correção). O processamento em si (after) é desligado — só a decisão
// 200/401 importa aqui.
// ---------------------------------------------------------------------------

let storedAppSecret: string | null = null
let selectCalls = 0
const updates: Array<Record<string, unknown>> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit', 'neq', 'in', 'order']) {
        b[m] = () => b
      }
      b.single = async () => (selectCalls++, {
        data: storedAppSecret === null ? null : { app_secret: storedAppSecret },
        error: null,
      })
      b.update = (row: Record<string, unknown>) => {
        updates.push(row)
        return b
      }
      return b
    },
  }),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: () => {} }
})
vi.mock('@/lib/audit/context', () => ({
  auditFetch: fetch,
  registerAuditActor: async () => {},
}))
vi.mock('@/lib/logger', () => ({ writeLog: async () => {}, maskPhone: (p: string) => p }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => {} }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: async () => {} }))
vi.mock('@/lib/ai/sentiment-trigger', () => ({ maybeScheduleSentiment: () => {} }))
vi.mock('@/lib/disparador/reply-tracker', () => ({ recordCampaignReply: async () => {} }))
vi.mock('@/lib/webchat/campaign', () => ({ maybeStartCampaignWebchat: async () => {} }))
vi.mock('@/lib/storage/chat-media', () => ({ chatMediaReference: () => null }))

const { POST } = await import('./route')

const CHANNEL_SECRET = 'channel-app-secret-0123456789abcdef'
const GLOBAL_SECRET = process.env.META_APP_SECRET! // "test-meta-app-secret" (vitest.config)

const body = JSON.stringify({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PNID-1' } } }] }],
})

function sign(secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function req(signature: string): Request {
  return new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST',
    body,
    headers: { 'x-hub-signature-256': signature },
  })
}

describe('POST /api/whatsapp/webhook — app_secret por canal', () => {
  beforeEach(() => {
    storedAppSecret = null
    updates.length = 0
    selectCalls = 0
    clearAppSecretCache()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('app_secret cifrado: aceita assinatura com o segredo do canal', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
  })

  it('app_secret cifrado: rejeita assinatura com o segredo global (sem fallback)', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(GLOBAL_SECRET)))).status).toBe(401)
  })

  it('app_secret legado em texto puro: é usado como segredo do canal', async () => {
    storedAppSecret = CHANNEL_SECRET
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
  })

  it('app_secret legado em texto puro desatualizado: mantém o fallback global de antes', async () => {
    storedAppSecret = 'valor-legado-desatualizado'
    expect((await POST(req(sign(GLOBAL_SECRET)))).status).toBe(200)
  })

  it('assinatura inválida continua rejeitada com app_secret legado', async () => {
    storedAppSecret = CHANNEL_SECRET
    expect((await POST(req(sign('outro-segredo')))).status).toBe(401)
  })

  it('canal sem app_secret: usa META_APP_SECRET', async () => {
    storedAppSecret = null
    expect((await POST(req(sign(GLOBAL_SECRET)))).status).toBe(200)
  })

  it('cache: segundo POST do mesmo canal não vai ao banco', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
    expect(selectCalls).toBe(1)
  })

  it('cache: assinatura inválida com segredo em cache relê o banco uma vez (rotação)', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
    const ROTATED = 'segredo-rotacionado-0123456789abcdef'
    storedAppSecret = encrypt(ROTATED)
    expect((await POST(req(sign(ROTATED)))).status).toBe(200)
    expect(selectCalls).toBe(2)
    expect((await POST(req(sign('outro-segredo')))).status).toBe(401)
  })
})
