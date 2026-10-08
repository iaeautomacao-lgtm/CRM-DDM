import { beforeEach, describe, expect, it, vi } from 'vitest'

// PRD 14, SW-2: URL externa de mídia precisa apontar para host público antes de ir ao
// provedor (WAHA/Meta); referência do próprio bucket continua sendo assinada.

const signed = vi.fn(async () => ({ data: { signedUrl: 'https://assinada.example/x?t=1' }, error: null }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ storage: { from: () => ({ createSignedUrl: signed }) } }),
}))

const { MediaUrlNotAllowedError, resolveProviderMedia } = await import('./provider-media')

beforeEach(() => {
  vi.stubEnv('SSRF_ALLOWED_HOSTS', '')
})

describe('resolveProviderMedia — URL externa', () => {
  it.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:3000/x.png',
    'http://[::1]/x.png',
    'http://10.0.0.5/x.png',
    'file:///etc/passwd',
    'https://user:pass@example.com/x.png',
  ])('bloqueia %s', async (url) => {
    await expect(resolveProviderMedia(url, 'acc-1')).rejects.toBeInstanceOf(MediaUrlNotAllowedError)
  })

  it('aceita IP público literal e devolve a URL sem alterar', async () => {
    await expect(resolveProviderMedia('https://93.184.216.34/a.png', 'acc-1')).resolves.toBe('https://93.184.216.34/a.png')
  })

  it('host da allowlist (SSRF_ALLOWED_HOSTS) passa', async () => {
    vi.stubEnv('SSRF_ALLOWED_HOSTS', '127.0.0.1')
    await expect(resolveProviderMedia('http://127.0.0.1/a.png', 'acc-1')).resolves.toBe('http://127.0.0.1/a.png')
  })
})
