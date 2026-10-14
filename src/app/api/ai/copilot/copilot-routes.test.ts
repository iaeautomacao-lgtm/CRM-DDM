import { beforeEach, describe, expect, it, vi } from 'vitest'

// Rotas do Acordito: permissão, validação do contrato e mapeamento dos códigos. A regra de negócio está em lib/ai/copilot*.test.ts.
const state = vi.hoisted(() => ({
  guard: { ok: true } as { ok: boolean },
  denied: null as Response | null,
  outcome: null as unknown,
  feedback: { ok: true } as { ok: boolean },
  config: { enabled: false, guidance: '' },
  upsert: vi.fn(async () => ({ error: null as { code?: string } | null })),
  guarded: [] as string[],
}))

vi.mock('@/lib/auth/route-guard', () => ({
  guardPermission: async (permission: string) => {
    state.guarded.push(permission)
    return state.guard.ok
      ? { ok: true, ctx: { supabase: { tag: 'user-db' }, accountId: 'acc-1', userId: 'user-1' } }
      : { ok: false, response: state.denied }
  },
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ tag: 'admin-db', from: () => ({ upsert: state.upsert }) }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiCopilot: { limit: 20, windowMs: 60_000 } },
}))
vi.mock('@/lib/ai/copilot', async (orig) => {
  const real = await orig<typeof import('@/lib/ai/copilot')>()
  return { ...real, getCopilotSuggestions: vi.fn(async () => state.outcome), loadCopilotConfig: vi.fn(async () => state.config) }
})
vi.mock('@/lib/ai/copilot-feedback', async (orig) => {
  const real = await orig<typeof import('@/lib/ai/copilot-feedback')>()
  return { ...real, recordCopilotFeedback: vi.fn(async () => state.feedback) }
})
vi.mock('@/lib/audit/log-event', () => ({ logAuditEvent: vi.fn(async () => {}) }))

import { getCopilotSuggestions } from '@/lib/ai/copilot'
import { POST as suggestions } from './suggestions/route'
import { POST as feedback } from './feedback/route'
import { GET as configGet, PUT as configPut } from '../../account/copilot-config/route'

const CONV = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown) => new Request('https://crm.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const put = (body: unknown) => new Request('https://crm.test/api', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  state.guard = { ok: true }
  state.denied = new Response(JSON.stringify({ error: 'sem permissão' }), { status: 403 })
  state.outcome = { ok: true, suggestions: [{ id: 's1', text: 'oi' }], basedOnMessageId: 'm1', cached: false }
  state.feedback = { ok: true }
  state.config = { enabled: true, guidance: 'Tom da casa.' }
  state.guarded = []
})

describe('POST /api/ai/copilot/suggestions', () => {
  it('exige inbox.reply e não chama a lib sem permissão', async () => {
    state.guard = { ok: false }
    const res = await suggestions(post({ conversationId: CONV }))
    expect(res.status).toBe(403)
    expect(state.guarded).toEqual(['inbox.reply'])
    expect(getCopilotSuggestions).not.toHaveBeenCalled()
  })

  it('devolve o contrato: suggestions, basedOnMessageId, cached; usa o cliente do usuário (RLS) e o admin por conta', async () => {
    const res = await suggestions(post({ conversationId: CONV, force: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ suggestions: [{ id: 's1', text: 'oi' }], basedOnMessageId: 'm1', cached: false })
    expect(getCopilotSuggestions).toHaveBeenCalledWith({
      userDb: { tag: 'user-db' },
      adminDb: expect.objectContaining({ tag: 'admin-db' }),
      accountId: 'acc-1',
      userId: 'user-1',
      conversationId: CONV,
      force: true,
    })
  })

  it.each([
    ['ai_not_configured', 409],
    ['copilot_disabled', 409],
    ['quota_exceeded', 429],
    ['forbidden', 403],
    ['ai_failed', 502],
  ])('erro %s vira HTTP %i com o code', async (code, status) => {
    state.outcome = { ok: false, code }
    const res = await suggestions(post({ conversationId: CONV }))
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
  })

  it('valida o corpo: conversationId UUID e force booleano', async () => {
    expect((await suggestions(post({}))).status).toBe(400)
    expect((await suggestions(post({ conversationId: 'abc' }))).status).toBe(400)
    expect((await suggestions(post({ conversationId: CONV, force: 'sim' }))).status).toBe(400)
    expect(getCopilotSuggestions).not.toHaveBeenCalled()
  })

  it('falha inesperada: 500 sem vazar detalhe', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getCopilotSuggestions).mockRejectedValueOnce(new Error('segredo interno'))
    const res = await suggestions(post({ conversationId: CONV }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('segredo')
  })
})

describe('POST /api/ai/copilot/feedback', () => {
  it('exige inbox.reply', async () => {
    state.guard = { ok: false }
    expect((await feedback(post({ suggestionId: 's1', action: 'used' }))).status).toBe(403)
    expect(state.guarded).toEqual(['inbox.reply'])
  })

  it.each(['used', 'edited', 'ignored'])('ação %s grava e responde 204 sem corpo', async (action) => {
    const res = await feedback(post({ suggestionId: 's1', action }))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('valida suggestionId e action; sugestão desconhecida é 404', async () => {
    expect((await feedback(post({ action: 'used' }))).status).toBe(400)
    expect((await feedback(post({ suggestionId: 's1', action: 'enviado' }))).status).toBe(400)
    expect((await feedback(post({ suggestionId: 'x'.repeat(65), action: 'used' }))).status).toBe(400)
    state.feedback = { ok: false }
    const res = await feedback(post({ suggestionId: 's1', action: 'used' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('not_found')
  })
})

describe('GET/PUT /api/account/copilot-config', () => {
  it('ler pede inbox.view e devolve enabled e guidance (padrão neutro quando vazia)', async () => {
    const res = await configGet()
    expect(state.guarded).toEqual(['inbox.view'])
    expect(await res.json()).toEqual({ enabled: true, guidance: 'Tom da casa.' })
    state.config = { enabled: false, guidance: '' }
    expect((await (await configGet()).json()).guidance).toBe('Sugira respostas curtas, educadas e objetivas em português.')
  })

  it('gravar pede ai.config, valida o corpo e faz upsert por conta', async () => {
    const ok = await configPut(put({ enabled: true, guidance: '  Seja breve.  ' }))
    expect(ok.status).toBe(200)
    expect(state.guarded).toEqual(['ai.config'])
    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'acc-1', enabled: true, guidance: 'Seja breve.', updated_by: 'user-1' }),
      { onConflict: 'account_id' },
    )
    expect((await configPut(put({ enabled: 'sim', guidance: '' }))).status).toBe(400)
    expect((await configPut(put({ enabled: true }))).status).toBe(400)
    expect((await configPut(put({ enabled: true, guidance: 'x'.repeat(4001) }))).status).toBe(413)
  })

  it('sem ai.config não grava', async () => {
    state.guard = { ok: false }
    expect((await configPut(put({ enabled: true, guidance: '' }))).status).toBe(403)
    expect(state.upsert).not.toHaveBeenCalled()
  })

  it('erro do banco: 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state.upsert.mockResolvedValueOnce({ error: { code: 'X' } })
    expect((await configPut(put({ enabled: true, guidance: '' }))).status).toBe(500)
  })
})
