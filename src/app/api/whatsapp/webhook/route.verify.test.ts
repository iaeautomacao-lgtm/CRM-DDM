import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// PRD 14, SG-9: GET de verificação do webhook Meta — token comparado em tempo constante
// (tamanhos diferentes = "não bate") e teto por IP. A forma de verificação não muda.

let rows: Array<{ id: string; verify_token: string | null }> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: async () => ({ data: rows, error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}))
vi.mock('@/lib/audit/context', () => ({
  auditFetch: fetch,
  registerAuditActor: async () => {},
  clientIp: (h: Headers) => h.get('x-real-ip'),
}))
vi.mock('@/lib/logger', () => ({ writeLog: async () => {}, maskPhone: (p: string) => p }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => {} }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: async () => {} }))
vi.mock('@/lib/ai/sentiment-trigger', () => ({ maybeScheduleSentiment: () => {} }))
vi.mock('@/lib/disparador/reply-tracker', () => ({ recordCampaignReply: async () => {} }))
vi.mock('@/lib/webchat/campaign', () => ({ maybeStartCampaignWebchat: async () => {} }))
vi.mock('@/lib/storage/chat-media', () => ({ chatMediaReference: () => null }))

const { GET } = await import('./route')

function verify(token: string, ip = '203.0.113.9'): Request {
  const url = `http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=${encodeURIComponent(token)}`
  return new Request(url, { headers: { 'x-real-ip': ip } })
}

beforeEach(() => {
  __resetRateLimitForTests()
  rows = [{ id: 'c1', verify_token: encrypt('token-correto-123') }]
})

describe('GET /api/whatsapp/webhook — verificação', () => {
  it('token certo devolve o challenge em texto puro', async () => {
    const res = await GET(verify('token-correto-123'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc123')
  })

  it('token errado (mesmo tamanho) e token de tamanho diferente dão 403, sem lançar', async () => {
    expect((await GET(verify('token-correto-124'))).status).toBe(403)
    expect((await GET(verify('curto'))).status).toBe(403)
    expect((await GET(verify('token-correto-123-mais-longo'))).status).toBe(403)
  })

  it('varre todos os canais: o token de qualquer um vale', async () => {
    rows = [
      { id: 'c0', verify_token: null },
      { id: 'c1', verify_token: encrypt('outro-token-aaa') },
      { id: 'c2', verify_token: encrypt('token-correto-123') },
    ]
    expect((await GET(verify('token-correto-123'))).status).toBe(200)
  })

  it('teto por IP: depois de 30 tentativas na janela devolve 429; outro IP não é afetado', async () => {
    for (let i = 0; i < 30; i++) expect((await GET(verify(`chute-${i}`, '198.51.100.1'))).status).toBe(403)
    expect((await GET(verify('token-correto-123', '198.51.100.1'))).status).toBe(429)
    expect((await GET(verify('token-correto-123', '198.51.100.2'))).status).toBe(200)
  })
})
