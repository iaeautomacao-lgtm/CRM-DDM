import { beforeEach, describe, expect, it, vi } from 'vitest'

let denied = false
let limited = false
const rewriteDraft = vi.fn()

vi.mock('@/lib/auth/route-guard', () => ({
  guardPermission: async (perm: string) =>
    denied
      ? { ok: false, response: new Response(JSON.stringify({ error: 'forbidden', perm }), { status: 403 }) }
      : { ok: true, ctx: { accountId: 'acc-1', userId: 'u1', supabase: null } },
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ tag: 'admin' }) }))
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { aiRewrite: { limit: 20, windowMs: 60_000 } },
  checkRateLimit: async (key: string) => ({ success: !limited, reset: Date.now() + 5000, key }),
  rateLimitResponse: () => new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
}))
vi.mock('@/lib/ai/rewrite', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/rewrite')>('@/lib/ai/rewrite')
  return { ...actual, rewriteDraft: (...a: unknown[]) => rewriteDraft(...a) }
})

import { POST } from './route'

const post = (body: unknown) => POST(new Request('http://x/api/ai/rewrite', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  denied = false
  limited = false
  rewriteDraft.mockReset()
  rewriteDraft.mockResolvedValue({ ok: true, result: { corrected: 'Oi!', variations: [{ tone: 'cordial', label: 'Cordial', text: 'Olá!' }] } })
})

describe('POST /api/ai/rewrite', () => {
  it('devolve o corrigido e as variações; usa a conta do operador e todos os tons por padrão', async () => {
    const r = await post({ text: '  oi  ' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, corrected: 'Oi!', variations: [{ tone: 'cordial', label: 'Cordial', text: 'Olá!' }] })
    expect(rewriteDraft).toHaveBeenCalledWith({ tag: 'admin' }, 'acc-1', 'oi', ['formal', 'cordial', 'objetivo'])
  })

  it('respeita a lista de tons pedida (sem repetir)', async () => {
    await post({ text: 'oi', tones: ['formal', 'formal', 'objetivo'] })
    expect(rewriteDraft.mock.calls[0][3]).toEqual(['formal', 'objetivo'])
  })

  it('valida o corpo: texto vazio, grande demais, tons inválidos, JSON quebrado', async () => {
    expect((await post({ text: '   ' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await post('{nao-json')).status).toBe(400)
    expect((await post({ text: 'x'.repeat(4001) })).status).toBe(413)
    expect((await post({ text: 'oi', tones: ['engraçado'] })).status).toBe(400)
    expect((await post({ text: 'oi', tones: [] })).status).toBe(400)
    expect(rewriteDraft).not.toHaveBeenCalled()
  })

  it('conta sem chave de IA = 409 ai_not_configured; falha/resposta inválida da IA = 502', async () => {
    rewriteDraft.mockResolvedValueOnce({ ok: false, code: 'ai_not_configured', error: 'sem chave' })
    const a = await post({ text: 'oi' })
    expect(a.status).toBe(409)
    expect(await a.json()).toMatchObject({ code: 'ai_not_configured' })
    rewriteDraft.mockResolvedValueOnce({ ok: false, code: 'ai_failed', error: 'x' })
    expect((await post({ text: 'oi' })).status).toBe(502)
    rewriteDraft.mockResolvedValueOnce({ ok: false, code: 'ai_bad_response', error: 'x' })
    expect((await post({ text: 'oi' })).status).toBe(502)
  })

  it('limite por usuário (429) e sem permissão (403) não chegam à IA', async () => {
    limited = true
    expect((await post({ text: 'oi' })).status).toBe(429)
    limited = false
    denied = true
    expect((await post({ text: 'oi' })).status).toBe(403)
    expect(rewriteDraft).not.toHaveBeenCalled()
  })
})
