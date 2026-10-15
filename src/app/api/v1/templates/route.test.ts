import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/v1/templates — escopos aceitos, filtros (status/idioma/prefixo/canal), cursor keyset e sendable_via_api.

const state = vi.hoisted(() => ({
  scopes: ['templates:read'] as string[],
  channels: [] as Array<Record<string, any>>,
  templates: [] as Array<Record<string, any>>,
  calls: [] as Array<[string, ...any[]]>,
}))

function chain(table: string) {
  const b: any = {}
  for (const m of ['select', 'eq', 'ilike', 'or', 'order', 'limit', 'in']) {
    b[m] = (...a: any[]) => (table === 'message_templates' && state.calls.push([m, ...a]), b)
  }
  b.then = (resolve: (v: unknown) => void) => {
    const limitCall = state.calls.find((c) => c[0] === 'limit')
    const rows = table === 'whatsapp_config' ? state.channels : state.templates.slice(0, (limitCall?.[1] as number) ?? 1000)
    return resolve({ data: rows, error: null })
  }
  return b
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async (_r: Request, scope: string[]) => {
    if (!scope.some((s) => state.scopes.includes(s))) {
      const { forbidden } = await import('@/lib/api/v1/respond')
      throw forbidden('sem escopo')
    }
    return { accountId: 'ACC', keyId: 'KEY', scopes: state.scopes, supabase: { from: (t: string) => chain(t) } }
  },
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))

const { GET } = await import('./route')

const C1 = { id: '5b0e5a64-0000-4000-8000-000000000011', waba_id: 'W1', display_phone_number: '+55 27 99999-1212' }
const C2 = { id: '5b0e5a64-0000-4000-8000-000000000012', waba_id: 'W2', display_phone_number: '+55 11 98888-0000' }
const tpl = (over: Record<string, unknown> = {}) => ({
  id: 'id-1',
  name: 'lembrete',
  language: 'pt_BR',
  category: 'Utility',
  status: 'APPROVED',
  waba_id: 'W1',
  body_text: 'Olá {{1}}, vence {{2}}.',
  header_type: null,
  header_content: null,
  footer_text: null,
  buttons: [{ type: 'QUICK_REPLY' }],
  sample_values: { body: ['Ana', '150,00'] },
  quality_score: 'GREEN',
  updated_at: '2026-10-14T12:00:00Z',
  ...over,
})
const get = (qs = '') => GET(new Request(`http://localhost/api/v1/templates${qs}`))
const callsOf = (m: string) => state.calls.filter((c) => c[0] === m).map((c) => c.slice(1))

beforeEach(() => {
  Object.assign(state, { scopes: ['templates:read'], channels: [C1, C2], templates: [tpl()], calls: [] })
})

describe('GET /api/v1/templates', () => {
  it.each([['templates:read'], ['messages:send'], ['campaigns:write']])('aceita o escopo %s', async (scope) => {
    state.scopes = [scope]
    expect((await get()).status).toBe(200)
  })

  it('recusa chave sem nenhum dos escopos (403)', async () => {
    state.scopes = ['reports:read']
    expect((await get()).status).toBe(403)
  })

  it('item no formato da spec: categoria em maiúsculas, placeholders, canais da WABA e sendable_via_api', async () => {
    const body = await (await get()).json()
    expect(body.data.next_cursor).toBeNull()
    expect(body.data.items[0]).toEqual({
      id: 'id-1',
      name: 'lembrete',
      language: 'pt_BR',
      category: 'UTILITY',
      status: 'APPROVED',
      waba_id: 'W1',
      channels: [{ id: C1.id, label: C1.display_phone_number }],
      placeholders: { body: 2, examples: ['Ana', '150,00'] },
      body: 'Olá {{1}}, vence {{2}}.',
      header_type: null,
      buttons: ['QUICK_REPLY'],
      quality: 'GREEN',
      sendable_via_api: true,
      unsupported_reason: null,
      updated_at: '2026-10-14T12:00:00Z',
    })
  })

  it('template com cabeçalho de mídia ou botão de Flow: sendable_via_api=false com o motivo', async () => {
    state.templates = [tpl({ header_type: 'IMAGE' }), tpl({ id: 'id-2', buttons: [{ type: 'FLOW' }] })]
    const items = (await (await get()).json()).data.items
    expect(items[0]).toMatchObject({ header_type: 'image', sendable_via_api: false })
    expect(items[0].unsupported_reason).toMatch(/cabeçalho de mídia/)
    expect(items[1].unsupported_reason).toMatch(/Flow/)
  })

  it('padrão filtra APPROVED; status=all não filtra; status inválido → 400', async () => {
    await get()
    expect(callsOf('ilike')).toContainEqual(['status', 'APPROVED'])
    state.calls = []
    await get('?status=all')
    expect(callsOf('ilike').some((c) => c[0] === 'status')).toBe(false)
    expect((await get('?status=xpto')).status).toBe(400)
  })

  it('filtra por idioma, prefixo do nome (escapando _) e conta sempre pela conta da chave', async () => {
    await get('?language=pt_BR&name=lembre_te')
    expect(callsOf('eq')).toContainEqual(['account_id', 'ACC'])
    expect(callsOf('eq')).toContainEqual(['language', 'pt_BR'])
    expect(callsOf('ilike')).toContainEqual(['name', 'lembre\\_te%'])
    expect((await get("?name=a'b")).status).toBe(400)
  })

  it('channel (UUID ou número) filtra pela WABA do canal; canal desconhecido → 400', async () => {
    await get(`?channel=${C2.id}`)
    expect(callsOf('eq')).toContainEqual(['waba_id', 'W2'])
    state.calls = []
    await get('?channel=5527999991212')
    expect(callsOf('eq')).toContainEqual(['waba_id', 'W1'])
    expect((await get('?channel=5599000000000')).status).toBe(400)
  })

  it('limit 1..200 e cursor keyset (name,id): devolve next_cursor quando há mais e o filtra na página seguinte', async () => {
    state.templates = [tpl({ id: 'a1', name: 'aaa' }), tpl({ id: 'b2', name: 'bbb' }), tpl({ id: 'c3', name: 'ccc' })]
    const first = await (await get('?limit=2')).json()
    expect(first.data.items.map((i: any) => i.name)).toEqual(['aaa', 'bbb'])
    expect(callsOf('limit')).toContainEqual([3])
    const cursor = first.data.next_cursor as string
    expect(cursor).toBeTruthy()
    state.calls = []
    await get(`?limit=2&cursor=${cursor}`)
    expect(callsOf('or')[0][0]).toBe('name.gt.bbb,and(name.eq.bbb,id.gt.b2)')
    expect((await get('?limit=0')).status).toBe(400)
    expect((await get('?cursor=lixo')).status).toBe(400)
  })

  it('não devolve dado pessoal nem token', async () => {
    const text = JSON.stringify(await (await get()).json())
    expect(text).not.toMatch(/access_token|phone_number_id|user_id/)
  })
})
