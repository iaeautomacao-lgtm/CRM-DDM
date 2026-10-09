import { beforeEach, describe, expect, it, vi } from 'vitest'

// PRD 14, SW-2: URL externa de mídia precisa apontar para host público antes de ir ao
// provedor (WAHA/Meta); referência do próprio bucket continua sendo assinada.

const signed = vi.fn(async () => ({ data: { signedUrl: 'https://assinada.example/x?t=1' }, error: null }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ storage: { from: () => ({ createSignedUrl: signed }) } }),
}))

const { MediaUrlNotAllowedError, resolveProviderMedia, resetProviderMediaCache } = await import('./provider-media')

beforeEach(() => {
  vi.stubEnv('SSRF_ALLOWED_HOSTS', '')
  resetProviderMediaCache()
  signed.mockClear()
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

describe('resolveProviderMedia — cache curto (mesmo anexo para toda a campanha)', () => {
  const ref = '/api/chat-media/account-acc-1/campanha/banner.png'

  it('a mesma mídia assina UMA vez, mesmo com 50 envios simultâneos', async () => {
    const urls = await Promise.all(Array.from({ length: 50 }, () => resolveProviderMedia(ref, 'acc-1')))
    expect(new Set(urls).size).toBe(1)
    expect(signed).toHaveBeenCalledTimes(1)
    expect(signed).toHaveBeenCalledWith('account-acc-1/campanha/banner.png', 600)
  })

  it('depois de 5 min assina de novo (o provedor sempre recebe uma URL com >= 5 min de validade)', async () => {
    const t0 = 1_000_000
    await resolveProviderMedia(ref, 'acc-1', t0)
    await resolveProviderMedia(ref, 'acc-1', t0 + 4 * 60_000)
    expect(signed).toHaveBeenCalledTimes(1)
    await resolveProviderMedia(ref, 'acc-1', t0 + 5 * 60_000 + 1)
    expect(signed).toHaveBeenCalledTimes(2)
  })

  it('a checagem de conta NÃO é pulada pelo cache: anexo de outra conta continua recusado', async () => {
    await resolveProviderMedia(ref, 'acc-1')
    await expect(resolveProviderMedia(ref, 'acc-2')).rejects.toThrow(/não autorizado/)
    expect(signed).toHaveBeenCalledTimes(1)
  })

  it('falha do Storage nunca fica em cache', async () => {
    signed.mockResolvedValueOnce({ data: null as never, error: { message: 'storage fora' } as never })
    await expect(resolveProviderMedia(ref, 'acc-1')).rejects.toThrow(/preparar o anexo/)
    await new Promise((r) => setTimeout(r, 0))
    await expect(resolveProviderMedia(ref, 'acc-1')).resolves.toContain('assinada.example')
    expect(signed).toHaveBeenCalledTimes(2)
  })

  it('URL externa pública é verificada uma vez; a bloqueada continua bloqueada', async () => {
    await expect(resolveProviderMedia('https://93.184.216.34/a.png', 'acc-1')).resolves.toBe('https://93.184.216.34/a.png')
    await expect(resolveProviderMedia('https://93.184.216.34/a.png', 'acc-1')).resolves.toBe('https://93.184.216.34/a.png')
    await expect(resolveProviderMedia('http://127.0.0.1/admin', 'acc-1')).rejects.toBeInstanceOf(MediaUrlNotAllowedError)
    await expect(resolveProviderMedia('http://127.0.0.1/admin', 'acc-1')).rejects.toBeInstanceOf(MediaUrlNotAllowedError)
  })
})
