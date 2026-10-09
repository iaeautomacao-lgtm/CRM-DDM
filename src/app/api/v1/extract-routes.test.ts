import { beforeEach, describe, expect, it, vi } from 'vitest'

// Rotas de extração da API v1 (TASK38): escopo (403), outra conta (404), limite por chave (429), mídia sem URL por padrão e auditoria só
// com contagem. O banco é um fake: a ordem/seq/paginação em SQL real está em lib/api/v1/extract.sql.test.ts.
const ACC = 'acc-1'
let grantedScopes = ['conversations:read', 'messages:read']
const rpcCalls: Array<{ name: string; args: Record<string, any> }> = []
let messageRows: Array<Record<string, any>> = []
const audit = vi.fn()
const storageSign = vi.fn(async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://sig/${p}` })), error: null }))

vi.mock('@/lib/auth/api-context', async () => {
  const { forbidden } = await import('@/lib/api/v1/respond')
  return {
    requireApiKey: async (_req: Request, scope: string) => {
      if (!grantedScopes.includes(scope)) throw forbidden(`missing ${scope}`)
      return { authType: 'api_key', supabase: fakeDb(), accountId: ACC, keyId: 'key-1', scopes: grantedScopes, createdBy: null, userId: null }
    },
  }
})
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/api/v1/extract-audit', () => ({ auditExtraction: (a: unknown) => audit(a) }))
vi.mock('@/lib/storage/chat-media', () => ({ chatMediaPath: (u: string) => (u.startsWith('/api/chat-media/') ? u.slice('/api/chat-media/'.length) : null) }))

function fakeDb() {
  return {
    rpc: async (name: string, args: Record<string, any>) => {
      rpcCalls.push({ name, args })
      if (name === 'api_v1_messages') return { data: messageRows, error: null }
      return { data: [], error: null }
    },
    storage: { from: () => ({ createSignedUrls: storageSign }) },
    from(table: string) {
      const b: Record<string, any> = {}
      const filters: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => ((filters[c] = v), b)
      b.in = () => b
      b.gte = () => b
      b.lt = () => b
      b.not = () => b
      b.or = () => b
      b.order = () => b
      b.limit = () => b
      b.then = (resolve: (v: unknown) => void) => {
        // Só a conversa "conv-ok" existe, e só na conta da chave.
        if (table === 'conversations') return resolve({ data: filters.id === 'c0c0c0c0-0000-4000-8000-000000000001' && filters.account_id === ACC ? [{ id: filters.id }] : [], error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }
}

import { __resetRateLimitForTests } from '@/lib/rate-limit'
const { GET: listConversations } = await import('./conversations/route')
const { GET: listConversationMessages } = await import('./conversations/[id]/messages/route')
const { GET: listMessages } = await import('./messages/route')

const OK_CONV = 'c0c0c0c0-0000-4000-8000-000000000001'
const req = (path: string) => new Request(`http://localhost/api/v1${path}`)
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) })
const row = (over: Record<string, any> = {}) => ({
  id: 'm1', conversation_id: OK_CONV, seq: 1, created_at: '2026-10-08T14:00:00+00:00', sender_type: 'agent', sender_id: 'u1', origin: 'operator',
  content_type: 'image', content_text: null, media_url: '/api/chat-media/account-1/foto.png', template_name: null, status: 'read', reply_to_message_id: null, campaign_id: null, contact_id: 'ct1', ...over,
})

beforeEach(() => {
  grantedScopes = ['conversations:read', 'messages:read']
  rpcCalls.length = 0
  messageRows = [row()]
  audit.mockReset()
  storageSign.mockClear()
  __resetRateLimitForTests()
})

describe('escopo', () => {
  it('sem conversations:read a lista de conversas responde 403; sem messages:read as duas rotas de mensagens respondem 403', async () => {
    grantedScopes = ['messages:read']
    expect((await listConversations(req('/conversations'))).status).toBe(403)
    grantedScopes = ['conversations:read']
    expect((await listConversationMessages(req(`/conversations/${OK_CONV}/messages`), ctxFor(OK_CONV))).status).toBe(403)
    expect((await listMessages(req('/messages?from=2026-10-01&to=2026-10-02'))).status).toBe(403)
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('GET /conversations/{id}/messages', () => {
  it('conversa de outra conta (ou inexistente) = 404, sem consultar mensagens', async () => {
    const res = await listConversationMessages(req('/conversations/aaaaaaaa-0000-4000-8000-000000000009/messages'), ctxFor('aaaaaaaa-0000-4000-8000-000000000009'))
    expect(res.status).toBe(404)
    expect((await listConversationMessages(req('/conversations/xyz/messages'), ctxFor('xyz'))).status).toBe(404)
    expect(rpcCalls.filter((c) => c.name === 'api_v1_messages')).toHaveLength(0)
  })

  it('devolve a mensagem com autor e mídia SEM URL por padrão (e não assina nada)', async () => {
    const res = await listConversationMessages(req(`/conversations/${OK_CONV}/messages`), ctxFor(OK_CONV))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.items[0]).toMatchObject({ seq: 1, direction: 'outbound', author: { type: 'operator', id: 'u1' }, media: { type: 'image', mime: 'image/png', filename: 'foto.png', size: null } })
    expect(data.items[0].media.url).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('chat-media')
    expect(storageSign).not.toHaveBeenCalled()
    expect(rpcCalls[0].args).toMatchObject({ p_account_id: ACC, p_conversation_id: OK_CONV })
  })

  it('include_media_urls=true assina por 15 minutos', async () => {
    const res = await listConversationMessages(req(`/conversations/${OK_CONV}/messages?include_media_urls=true`), ctxFor(OK_CONV))
    const { data } = await res.json()
    expect(data.items[0].media.url).toBe('https://sig/account-1/foto.png')
    expect(storageSign).toHaveBeenCalledWith(['account-1/foto.png'], 900)
  })

  it('audita chave, rota, filtros e QUANTIDADE — nunca o conteúdo', async () => {
    messageRows = [row({ content_text: 'segredo do cliente' })]
    await listConversationMessages(req(`/conversations/${OK_CONV}/messages`), ctxFor(OK_CONV))
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit.mock.calls[0][0]).toMatchObject({ accountId: ACC, keyId: 'key-1', route: '/api/v1/conversations/{id}/messages', itemCount: 1 })
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain('segredo do cliente')
  })
})

describe('GET /messages (extração em massa)', () => {
  it('from e to são obrigatórios; período acima de 31 dias, invertido ou data inválida = 400', async () => {
    expect((await listMessages(req('/messages'))).status).toBe(400)
    expect((await listMessages(req('/messages?from=2026-10-01'))).status).toBe(400)
    expect((await listMessages(req('/messages?from=2026-10-10&to=2026-10-01'))).status).toBe(400)
    expect((await listMessages(req('/messages?from=2026-09-01&to=2026-10-09'))).status).toBe(400)
    expect((await listMessages(req('/messages?from=ontem&to=hoje'))).status).toBe(400)
    expect((await listMessages(req('/messages?from=2026-10-01&to=2026-10-02&limit=0'))).status).toBe(400)
    expect((await listMessages(req('/messages?from=2026-10-01&to=2026-10-02&cursor=lixo'))).status).toBe(400)
    expect(rpcCalls).toHaveLength(0)
  })

  it('31 dias exatos passam; filtros, limite e cursor chegam ao banco com a conta da chave', async () => {
    const res = await listMessages(req(`/messages?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&channel=webchat&team_id=7e7e7e7e-0000-4000-8000-000000000002&limit=5`))
    expect(res.status).toBe(200)
    expect(rpcCalls[0].args).toMatchObject({ p_account_id: ACC, p_from: '2026-10-01T00:00:00.000Z', p_to: '2026-11-01T00:00:00.000Z', p_channel: 'webchat', p_team_id: '7e7e7e7e-0000-4000-8000-000000000002', p_limit: 6 })
    expect(audit.mock.calls[0][0].filters).toMatchObject({ channel: 'webchat' })
  })

  it('limite máximo é 1000 por página', async () => {
    await listMessages(req('/messages?from=2026-10-01&to=2026-10-02&limit=99999'))
    expect(rpcCalls[0].args.p_limit).toBe(1001)
  })
})

describe('limite por chave: 60/min nas três rotas, com 429 e Retry-After', () => {
  it('a 61ª chamada do minuto é barrada, somando as três rotas', async () => {
    for (let i = 0; i < 20; i++) expect((await listConversations(req('/conversations'))).status).toBe(200)
    for (let i = 0; i < 20; i++) expect((await listConversationMessages(req(`/conversations/${OK_CONV}/messages`), ctxFor(OK_CONV))).status).toBe(200)
    for (let i = 0; i < 20; i++) expect((await listMessages(req('/messages?from=2026-10-01&to=2026-10-02'))).status).toBe(200)
    const blocked = await listConversations(req('/conversations'))
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
  })
})
