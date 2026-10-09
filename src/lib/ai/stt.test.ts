import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatTranscript, parseTranscript, resolveAccountSttKey, STT_MAX_BYTES, transcribeInboundAudio, transcribeWithKey } from './stt'

afterEach(() => vi.restoreAllMocks())

const dbWith = (data: unknown, error: { message: string } | null = null) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) }) as never

describe('formatTranscript / parseTranscript', () => {
  it('ida e volta, inclusive com aspas e quebras de linha no texto', () => {
    for (const t of ['quero pagar', 'ele disse "ok"', 'linha 1\nlinha 2']) expect(parseTranscript(formatTranscript(t))).toBe(t)
  })
  it('texto que não é transcrição (ou vazio) vira null', () => {
    expect(parseTranscript('oi')).toBeNull()
    expect(parseTranscript(null)).toBeNull()
    expect(parseTranscript(formatTranscript(''))).toBeNull()
  })
})

describe('resolveAccountSttKey — só a chave da conta, sem fallback para o .env', () => {
  const ok = { enabled: true, multimodal_enabled: true, api_provider: 'openai', api_key: ' sk-conta ' }

  it('devolve a chave da conta quando a IA e o multimodal estão ligados e o provider é openai', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-do-env')
    expect(await resolveAccountSttKey(dbWith(ok), 'acc')).toBe('sk-conta')
    vi.unstubAllEnvs()
  })

  it('sem chave na conta NÃO usa a do .env', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-do-env')
    expect(await resolveAccountSttKey(dbWith({ ...ok, api_key: '' }), 'acc')).toBeNull()
    vi.unstubAllEnvs()
  })

  it.each([
    [{ ...ok, enabled: false }],
    [{ ...ok, multimodal_enabled: false }],
    [{ ...ok, api_provider: 'claude' }],
    [null],
  ])('conta sem consentimento/config (%j) ⇒ null', async (cfg) => {
    expect(await resolveAccountSttKey(dbWith(cfg), 'acc')).toBeNull()
  })

  it('erro de leitura ⇒ null (nunca lança)', async () => {
    expect(await resolveAccountSttKey(dbWith(null, { message: 'x' }), 'acc')).toBeNull()
  })
})

describe('transcribeWithKey', () => {
  it('ok: manda o áudio com a chave informada e devolve o texto', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: ' olá ' }), { status: 200 }))
    const r = await transcribeWithKey(new Uint8Array([1, 2, 3]), 'sk-x', { fetchImpl: fetchImpl as never })
    expect(r).toEqual({ status: 'done', text: 'olá' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/audio\/transcriptions$/)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x')
  })

  it('HTTP de erro, texto vazio ou exceção ⇒ failed, sem lançar e sem vazar a chave no log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await transcribeWithKey(new Uint8Array(1), 'sk-segredo', { fetchImpl: (async () => new Response('x', { status: 401 })) as never })).status).toBe('failed')
    expect((await transcribeWithKey(new Uint8Array(1), 'sk-segredo', { fetchImpl: (async () => new Response('{"text":""}', { status: 200 })) as never })).status).toBe('failed')
    expect((await transcribeWithKey(new Uint8Array(1), 'sk-segredo', { fetchImpl: (async () => { throw new Error('sk-segredo caiu') }) as never })).status).toBe('failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-segredo')
  })
})

describe('transcribeInboundAudio — teto de tamanho', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('áudio acima do teto não sai do sistema (skipped) mesmo com chave', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true, api_provider: 'openai', api_key: 'sk-x', multimodal_enabled: true }, error: null }) }) }),
      }),
    }
    const big = new Uint8Array(STT_MAX_BYTES + 1)
    const r = await transcribeInboundAudio(db as never, 'acc-1', big, 'audio/ogg')
    expect(r).toEqual({ status: 'skipped', text: null })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('transcribeInboundAudio — contraprova do teto (mesma conta)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('áudio pequeno com a mesma chave chama a OpenAI', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ text: 'oi' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true, api_provider: 'openai', api_key: 'sk-x', multimodal_enabled: true }, error: null }) }) }),
      }),
    }
    const r = await transcribeInboundAudio(db as never, 'acc-1', new Uint8Array(10), 'audio/ogg')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(r.status).toBe('done')
  })
})
