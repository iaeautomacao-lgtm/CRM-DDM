import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// POST /api/v1/disparador/campaigns — idempotência opcional, teto de 20k,
// rollback em falha de enfileiramento, dedupe/inválidos e WAHA sem `$&`.
// Banco simulado em memória (só o que a rota usa).
// ---------------------------------------------------------------------------

type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
let failQueueInsertOnCall = 0
let queueInsertCalls = 0
let failMetrics = false
let idCounter = 0

function resetDb() {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.whatsapp_config = [
    { id: '11111111-1111-4111-8111-111111111111', account_id: 'ACC', provider: 'meta', habilitado: true, waba_id: 'W1', display_phone_number: '+55 21 3030-9159' },
  ]
  tables.message_templates = [{ id: 'T1', name: 'promo', language: 'pt_BR', waba_id: 'W1', status: 'APPROVED', account_id: 'ACC' }]
  tables.campaigns = []
  tables.disp_message_queue = []
  tables.campaign_metrics = []
  tables.blacklist = []
  failQueueInsertOnCall = 0
  queueInsertCalls = 0
  failMetrics = false
  idCounter = 0
}

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  let payload: any = null
  let single = false
  let maybe = false
  let range: [number, number] | null = null
  let limitN: number | null = null
  const b: any = {}
  b.select = () => b
  b.order = () => b
  b.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b)
  b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
  b.limit = (n: number) => ((limitN = n), b)
  b.range = (a: number, z: number) => ((range = [a, z]), b)
  b.single = () => ((single = true), b)
  b.maybeSingle = () => ((maybe = true), b)
  b.insert = (p: any) => ((op = 'insert'), (payload = p), b)
  b.upsert = (p: any) => ((op = 'upsert'), (payload = p), b)
  b.update = (p: any) => ((op = 'update'), (payload = p), b)
  b.delete = () => ((op = 'delete'), b)
  b.then = (resolve: (v: any) => void, reject: (e: any) => void) => {
    try {
      resolve(run())
    } catch (e) {
      reject(e)
    }
  }
  function run() {
    const rows = (tables[table] ??= [])
    const match = (r: Row) => filters.every((f) => f(r))
    if (op === 'insert') {
      const list: Row[] = Array.isArray(payload) ? payload : [payload]
      if (table === 'disp_message_queue') {
        queueInsertCalls++
        if (failQueueInsertOnCall && queueInsertCalls === failQueueInsertOnCall) {
          return { data: null, error: { message: 'boom' } }
        }
      }
      if (table === 'campaigns') {
        const p = list[0]
        if (p.idempotency_key && rows.some((r) => r.account_id === p.account_id && r.idempotency_key === p.idempotency_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate' } }
        }
      }
      const created = list.map((p) => ({ id: p.id ?? `ID-${++idCounter}`, ...p }))
      rows.push(...created)
      return { data: single ? created[0] : created, error: null }
    }
    if (op === 'upsert') {
      if (table === 'campaign_metrics' && failMetrics) return { data: null, error: { message: 'metrics down' } }
      const p = payload as Row
      const i = rows.findIndex((r) => r.campaign_id === p.campaign_id)
      if (i >= 0) rows[i] = { ...rows[i], ...p }
      else rows.push(p)
      return { data: null, error: null }
    }
    if (op === 'update') {
      rows.filter(match).forEach((r) => Object.assign(r, payload))
      return { data: null, error: null }
    }
    if (op === 'delete') {
      tables[table] = rows.filter((r) => !match(r))
      return { data: null, error: null }
    }
    let out = rows.filter(match)
    if (range) out = out.slice(range[0], range[1] + 1)
    if (limitN != null) out = out.slice(0, limitN)
    if (single || maybe) return { data: out[0] ?? null, error: null }
    return { data: out, error: null }
  }
  return b
}

vi.mock('@/lib/disparador/admin-client', () => ({ supabaseAdmin: () => ({ from: builder }) }))
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({ accountId: 'ACC', keyId: 'KEY', createdBy: 'USER', scopes: ['campaigns:write'] }),
}))
vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => {} }))
vi.mock('@/lib/whatsapp/waha-api', () => ({ assertWahaUrlIsSafe: async () => {} }))
vi.mock('@/lib/disparador/processQueue', () => ({ EXTERNAL_WAHA_TEXT_MARKER: '__EXTERNAL_WAHA_TEXT__' }))

const { POST } = await import('./route')

function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request('http://localhost/api/v1/disparador/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  })
}
const contacts = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ phone: `55119${String(10_000_000 + start + i)}`, variables: ['Ana'] }))
const base = (over: Record<string, unknown> = {}) => ({
  campaign_name: 'Promo',
  template_name: 'promo',
  channel: '11111111-1111-4111-8111-111111111111',
  contacts: contacts(3),
  ...over,
})

describe('POST /api/v1/disparador/campaigns', () => {
  beforeEach(() => {
    resetDb()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('Meta rejeita template legado sem waba_id mesmo se APPROVED', async () => {
    tables.message_templates = [
      { id: 'LEGACY', name: 'promo', language: 'pt_BR', waba_id: null, status: 'APPROVED', account_id: 'ACC' },
    ];
    const r = await POST(post(base()));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/WABA do canal selecionado/);
    expect(tables.campaigns).toHaveLength(0);
  });

  it('Meta rejeita template aprovado de outra WABA', async () => {
    tables.message_templates = [
      { id: 'OTHER', name: 'promo', language: 'pt_BR', waba_id: 'W2', status: 'APPROVED', account_id: 'ACC' },
    ];
    const r = await POST(post(base()));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/WABA do canal selecionado/);
    expect(tables.campaigns).toHaveLength(0);
  });

  it('sem chave de idempotência: cria normal (e repetir cria outra, como antes)', async () => {
    const r1 = await POST(post(base()))
    expect(r1.status).toBe(201)
    const j1 = await r1.json()
    expect(j1.data).toMatchObject({ enqueued: 3, duplicates: 0, invalid: 0, skipped: 0 })
    const r2 = await POST(post(base()))
    expect(r2.status).toBe(201)
    expect(tables.campaigns).toHaveLength(2)
    expect(tables.campaigns[0].idempotency_key).toBeUndefined()
    expect(tables.campaigns[0].status).toBe('em_execucao')
    expect(tables.campaign_metrics[0].total_contatos).toBe(3)
  })

  it('Idempotency-Key: repetir o mesmo conteúdo devolve a mesma campanha (200) sem duplicar fila', async () => {
    const h = { 'idempotency-key': 'plan-2026-10-07-a' }
    const r1 = await POST(post(base(), h))
    expect(r1.status).toBe(201)
    const j1 = await r1.json()
    const r2 = await POST(post(base(), h))
    expect(r2.status).toBe(200)
    expect((await r2.json()).data).toEqual(j1.data)
    expect(tables.campaigns).toHaveLength(1)
    expect(tables.disp_message_queue).toHaveLength(3)
  })

  it('mesma chave com conteúdo diferente → 409', async () => {
    const h = { 'idempotency-key': 'plan-2026-10-07-a' }
    await POST(post(base(), h))
    const r = await POST(post(base({ contacts: contacts(4) }), h))
    expect(r.status).toBe(409)
    expect((await r.json()).error.code).toBe('conflict')
    expect(tables.campaigns).toHaveLength(1)
  })

  it('external_id funciona igual e vale por conta', async () => {
    const r1 = await POST(post(base({ external_id: 'PLAN-77' })))
    const r2 = await POST(post(base({ external_id: 'PLAN-77' })))
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(200)
    expect(tables.campaigns).toHaveLength(1)
    expect(tables.campaigns[0].idempotency_key).toBe('ext:PLAN-77')
  })

  it('criação em andamento (sem resposta guardada) → 409 em vez de duplicar', async () => {
    const h = { 'idempotency-key': 'plan-em-andamento' }
    await POST(post(base(), h))
    tables.campaigns[0].idempotency_response = null
    const r = await POST(post(base(), h))
    expect(r.status).toBe(409)
    expect(tables.campaigns).toHaveLength(1)
  })

  it('teto de 20.000 contatos → 413 orientando a dividir; 20.000 passa', async () => {
    const r = await POST(post(base({ contacts: Array.from({ length: 20_001 }, () => ({ phone: '11999998888' })) })))
    expect(r.status).toBe(413)
    const j = await r.json()
    expect(j.error.code).toBe('payload_too_large')
    expect(j.error.message).toMatch(/divida/)
    expect(tables.campaigns).toHaveLength(0)
  })

  it('Content-Length acima de 15 MB → 413 antes de ler o corpo', async () => {
    const r = await POST(post(base(), { 'content-length': String(16 * 1024 * 1024) }))
    expect(r.status).toBe(413)
  })

  it('JSON inválido → 400', async () => {
    const r = await POST(post(null, {}, '{nao-json'))
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe('bad_request')
  })

  it('janela inválida → 400 claro', async () => {
    const r = await POST(post(base({ janela_inicio: '18:00', janela_fim: '08:00' })))
    expect(r.status).toBe(400)
    expect((await r.json()).error.message).toMatch(/janela_fim/)
  })

  it('dedupe por phoneKey e inválidos contados na resposta (amostra com motivo)', async () => {
    const r = await POST(
      post(
        base({
          contacts: [
            { phone: '+55 11 99999-8888', variables: ['a'] },
            { phone: '11999998888', variables: ['a'] },
            { phone: '1199998888', variables: ['a'] },
            { phone: 'abc' },
            null,
            { phone: '+55 21 98888-7777', variables: ['b'] },
          ],
        })
      )
    )
    expect(r.status).toBe(201)
    const { data } = await r.json()
    expect(data).toMatchObject({ enqueued: 2, duplicates: 2, invalid: 2 })
    expect(data.invalid_sample.map((s: any) => s.reason)).toEqual(['missing_phone', 'invalid_contact'])
    expect(tables.disp_message_queue).toHaveLength(2)
  })

  it('tudo inválido → 400 com amostra e sem criar campanha', async () => {
    const r = await POST(post(base({ contacts: [{ phone: 'x' }, { phone: '12' }] })))
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j.error.invalid).toBe(2)
    expect(j.error.invalid_sample).toHaveLength(2)
    expect(tables.campaigns).toHaveLength(0)
  })

  it('agenda pelo relógio de janela (dias úteis por padrão) e grava dias_envio', async () => {
    await POST(post(base()))
    expect(tables.campaigns[0].dias_envio).toEqual([1, 2, 3, 4, 5])
    for (const row of tables.disp_message_queue) {
      const t = new Date(row.scheduled_at)
      // Brasília = UTC-3: dentro de 08:00–18:00 (+ espalhamento < 2 s) em dia útil.
      const brt = new Date(t.getTime() - 3 * 3_600_000)
      expect(brt.getUTCDay()).toBeGreaterThanOrEqual(1)
      expect(brt.getUTCDay()).toBeLessThanOrEqual(5)
      const minutes = brt.getUTCHours() * 60 + brt.getUTCMinutes()
      expect(minutes).toBeGreaterThanOrEqual(8 * 60)
      expect(minutes).toBeLessThanOrEqual(18 * 60)
    }
  })

  describe('WAHA', () => {
    beforeEach(() => {
      tables.whatsapp_config = [{ id: '22222222-2222-4222-8222-222222222222', account_id: 'ACC', provider: 'waha', habilitado: true }]
    })
    const waha = (over: Record<string, unknown> = {}) => ({
      campaign_name: 'W',
      message: 'Oi {{1}}, valor {{2}}',
      contacts: [{ phone: '11999998888', variables: ['$&', 'R$ 10 $1'] }],
      ...over,
    })

    it('substitui em passada única: $& e $1 literais', async () => {
      const r = await POST(post(waha()))
      expect(r.status).toBe(201)
      expect(tables.disp_message_queue[0].template_variables).toEqual(['Oi $&, valor R$ 10 $1'])
      expect(tables.disp_message_queue[0].template_name).toBe('__EXTERNAL_WAHA_TEXT__')
    })

    it('variável faltante: contato vira missing_variable e não é enfileirado', async () => {
      const r = await POST(
        post(
          waha({
            contacts: [
              { phone: '11999998888', variables: ['Ana'] },
              { phone: '11988887777', variables: ['Bia', '5'] },
            ],
          })
        )
      )
      expect(r.status).toBe(201)
      const { data } = await r.json()
      expect(data).toMatchObject({ enqueued: 1, invalid: 1 })
      expect(data.invalid_sample[0].reason).toBe('missing_variable')
      expect(tables.disp_message_queue.some((q) => String(q.template_variables[0]).includes('{{'))).toBe(false)
    })
  })

  describe('rollback', () => {
    it('falha no 2º bloco de inserção: apaga a fila, encerra a campanha e devolve 500 com campaign_id', async () => {
      failQueueInsertOnCall = 2
      const r = await POST(post(base({ contacts: contacts(1200) }), { 'idempotency-key': 'plan-rollback-1' }))
      expect(r.status).toBe(500)
      const j = await r.json()
      expect(j.error.code).toBe('internal')
      expect(j.error.campaign_id).toBe(tables.campaigns[0].id)
      expect(tables.disp_message_queue).toHaveLength(0)
      expect(tables.campaigns[0].status).toBe('encerrada')
      expect(tables.campaigns[0].idempotency_key).toBeNull()
      expect(tables.campaign_metrics).toHaveLength(0)

      // A chave foi liberada: repetir cria uma campanha nova e completa.
      failQueueInsertOnCall = 0
      const retry = await POST(post(base({ contacts: contacts(1200) }), { 'idempotency-key': 'plan-rollback-1' }))
      expect(retry.status).toBe(201)
      expect(tables.disp_message_queue).toHaveLength(1200)
    })

    it('erro no upsert de métricas: desfaz (nada fica em_execucao)', async () => {
      failMetrics = true
      const r = await POST(post(base()))
      expect(r.status).toBe(500)
      expect(tables.campaigns[0].status).toBe('encerrada')
      expect(tables.disp_message_queue).toHaveLength(0)
    })
  })
})
