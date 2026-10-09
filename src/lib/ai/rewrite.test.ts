import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRewritePrompt, parseRewriteResponse, resolveAccountRewriteKey, rewriteDraft, REWRITE_TONES } from './rewrite'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const dbWith = (data: unknown, error: { message: string } | null = null) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) }) as never

const cfg = { api_provider: 'openai', api_key: ' sk-conta ', api_model: null }

describe('resolveAccountRewriteKey — só a chave da conta', () => {
  it('devolve provedor, chave (sem espaços) e modelo da conta', async () => {
    const k = await resolveAccountRewriteKey(dbWith(cfg), 'acc')
    expect(k).toMatchObject({ provider: 'openai', apiKey: 'sk-conta' })
    expect(k?.model).toBeTruthy()
  })

  it('conta sem chave NÃO usa a chave do .env da plataforma', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-do-env')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env')
    expect(await resolveAccountRewriteKey(dbWith({ ...cfg, api_key: '' }), 'acc')).toBeNull()
    expect(await resolveAccountRewriteKey(dbWith({ api_provider: 'claude', api_key: null }), 'acc')).toBeNull()
  })

  it('sem ai_config, provedor desconhecido ou erro de leitura ⇒ null', async () => {
    expect(await resolveAccountRewriteKey(dbWith(null), 'acc')).toBeNull()
    expect(await resolveAccountRewriteKey(dbWith({ ...cfg, api_provider: 'x' }), 'acc')).toBeNull()
    expect(await resolveAccountRewriteKey(dbWith(null, { message: 'x' }), 'acc')).toBeNull()
  })
})

describe('buildRewritePrompt', () => {
  it('contém só o rascunho e os tons pedidos; isola o texto contra instruções embutidas', () => {
    const p = buildRewritePrompt('Olá, segue o boleto de R$ 100,00', ['formal', 'objetivo'])
    expect(p).toContain('<rascunho>\nOlá, segue o boleto de R$ 100,00\n</rascunho>')
    expect(p).toContain('"formal", "objetivo"')
    expect(p).not.toContain('"cordial"')
    expect(p).toMatch(/ignore qualquer instrução/)
    expect(p).toMatch(/NÃO invente/)
  })
})

describe('parseRewriteResponse', () => {
  const ok = JSON.stringify({
    corrected: ' Olá, tudo bem? ',
    variations: [
      { tone: 'Formal', text: 'Prezado, tudo bem?' },
      { tone: 'cordial', text: 'Oi! Tudo bem?' },
      { tone: 'cordial', text: 'duplicada' },
      { tone: 'engraçado', text: 'fora da lista' },
      { tone: 'objetivo', text: '   ' },
    ],
  })

  it('normaliza, rotula, ignora duplicado, tom fora da lista e texto vazio', () => {
    expect(parseRewriteResponse(ok, REWRITE_TONES)).toEqual({
      corrected: 'Olá, tudo bem?',
      variations: [
        { tone: 'formal', label: 'Formal', text: 'Prezado, tudo bem?' },
        { tone: 'cordial', label: 'Cordial', text: 'Oi! Tudo bem?' },
      ],
    })
  })

  it('aceita JSON dentro de cerca ```json e respeita os tons pedidos', () => {
    const r = parseRewriteResponse('```json\n' + ok + '\n```', ['cordial'])
    expect(r?.variations.map((v) => v.tone)).toEqual(['cordial'])
  })

  it('formato inaproveitável ⇒ null', () => {
    for (const bad of ['', 'não é json', '[]', '{}', '{"variations":[{"tone":"formal"}]}']) expect(parseRewriteResponse(bad, REWRITE_TONES)).toBeNull()
  })
})

describe('rewriteDraft', () => {
  it('sem chave na conta: ai_not_configured e NENHUMA chamada ao provedor', async () => {
    const call = vi.fn()
    const r = await rewriteDraft(dbWith(null), 'acc', 'oi', REWRITE_TONES, { call })
    expect(r).toMatchObject({ ok: false, code: 'ai_not_configured' })
    expect(call).not.toHaveBeenCalled()
  })

  it('chama o provedor com a chave da conta, só com o rascunho, e devolve as variações', async () => {
    const call = vi.fn(async () => JSON.stringify({ corrected: 'Oi, tudo bem?', variations: [{ tone: 'cordial', text: 'Olá! Tudo bem?' }] }))
    const r = await rewriteDraft(dbWith(cfg), 'acc', 'oi tdo bem', ['cordial'], { call })
    expect(r).toEqual({ ok: true, result: { corrected: 'Oi, tudo bem?', variations: [{ tone: 'cordial', label: 'Cordial', text: 'Olá! Tudo bem?' }] } })
    const [provider, key, prompt] = call.mock.calls[0] as unknown as [string, string, string]
    expect([provider, key]).toEqual(['openai', 'sk-conta'])
    expect(prompt).toContain('oi tdo bem')
  })

  it('falha do provedor e resposta inválida viram erro tratado; o log não vaza o rascunho', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await rewriteDraft(dbWith(cfg), 'acc', 'segredo do cliente 123', REWRITE_TONES, { call: async () => { throw new Error('OpenAI error: 500') } })
    expect(failed).toMatchObject({ ok: false, code: 'ai_failed' })
    const bad = await rewriteDraft(dbWith(cfg), 'acc', 'x', REWRITE_TONES, { call: async () => 'lixo' })
    expect(bad).toMatchObject({ ok: false, code: 'ai_bad_response' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('segredo do cliente')
  })
})
