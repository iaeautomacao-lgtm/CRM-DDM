import { describe, it, expect, vi, beforeEach } from 'vitest'

const safeFetchMock = vi.fn()

vi.mock('@/lib/security/ssrf-guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/security/ssrf-guard')>()),
  safeFetch: (...a: unknown[]) => safeFetchMock(...a),
}))
vi.mock('@/lib/whatsapp/waha-api', () => ({
  assertWahaUrlIsSafe: vi.fn(async () => undefined),
  WahaUrlBlockedError: class extends Error {},
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl: vi.fn(), downloadMedia: vi.fn() }))
// Migration 200b: segredos (waha_api_key) vêm do service role; o cliente de sessão só vê ids (RLS).
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['from', 'select', 'eq', 'in']) chain[m] = () => chain
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [{ id: 'cfg-1', waha_url: 'https://waha.example.com/', waha_api_key: 'k' }], error: null })
    return chain
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.limit = () => chain
      chain.maybeSingle = async () => ({ data: { account_id: 'a1' }, error: null })
      // whatsapp_config: só os ids visíveis pela RLS (etapa 1 de fetchChannelConfigs).
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'whatsapp_config' ? [{ id: 'cfg-1' }] : null, error: null })
      return chain
    },
  }),
}))

import { GET } from './route'

const call = (file?: string) =>
  GET(
    new Request(`http://app/api/whatsapp/media/waha${file === undefined ? '' : `?file=${encodeURIComponent(file)}`}`),
    { params: Promise.resolve({ mediaId: 'waha' }) },
  )

describe('GET /api/whatsapp/media/waha', () => {
  beforeEach(() => safeFetchMock.mockReset())

  it.each(['../sessions', 'default/../../api/sessions', '/etc/passwd', 'default/x?y=1', 'default/%2e%2e/x'])(
    'rejeita path traversal %j sem chamar o upstream',
    async (file) => {
      const res = await call(file)
      expect(res.status).toBe(400)
      expect(safeFetchMock).not.toHaveBeenCalled()
    },
  )

  it('exige o parâmetro file', async () => {
    expect((await call()).status).toBe(400)
  })

  it('não repassa text/html do upstream: força download + nosniff', async () => {
    safeFetchMock.mockResolvedValue(
      new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const res = await call('default/x.html')
    expect(safeFetchMock.mock.calls[0][0]).toBe('https://waha.example.com/api/files/default/x.html')
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toMatch(/^private/)
  })

  it('imagem segura continua inline', async () => {
    safeFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    )
    const res = await call('default/x.jpeg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-disposition')).toBe('inline')
  })
})
