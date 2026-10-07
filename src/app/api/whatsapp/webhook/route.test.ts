import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { clearAppSecretCache } from '@/lib/whatsapp/webhook-fast-path'

// ---------------------------------------------------------------------------
// Verificação de assinatura do webhook Meta com app_secret por canal:
// cifrado (formato atual) e texto puro legado (gravado direto no banco antes
// da correção; e isolamento entre contas (C-2): cada change só é processada
// se o seu canal validou a assinatura.
// ---------------------------------------------------------------------------

interface FakeChannel {
  id: string
  account_id: string
  app_secret: string | null
}
// phone_number_id → canal. PNID-1 (conta ACC-1) é controlado por storedAppSecret.
const extraChannels: Record<string, FakeChannel> = {}
let storedAppSecret: string | null = null
let selectCalls = 0
const updates: Array<Record<string, unknown>> = []
const ops: Array<{ table: string; op: string; filters: Array<[string, unknown]> }> = []
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
const afterCallbacks: Array<() => Promise<void>> = []
// Linha simulada de whatsapp_test_sends (aplica os filtros do update de verdade).
let testSendRow: { message_id: string; status: string; erro: string | null } | null = null

function channelFor(pn: string): FakeChannel | null {
  if (extraChannels[pn]) return extraChannels[pn]
  if (pn === 'PNID-1' && storedAppSecret !== null) {
    return { id: 'CFG-1', account_id: 'ACC-1', app_secret: storedAppSecret }
  }
  return null
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return { data: true, error: null }
    },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = []
      let op = 'select'
      let pendingRow: Record<string, unknown> | null = null
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'limit', 'neq', 'order']) b[m] = () => b
      b.eq = (col: string, val: unknown) => (filters.push([col, val]), b)
      b.in = (col: string, val: unknown) => (filters.push([col + ' in', val]), b)
      b.not = (col: string, _op: string, val: unknown) => (filters.push([col + ' not in', val]), b)
      b.single = async () => {
        selectCalls++
        const pn = filters.find(([c]) => c === 'phone_number_id')?.[1] as string | undefined
        const ch = pn ? channelFor(pn) : null
        return { data: ch, error: null }
      }
      b.update = (row: Record<string, unknown>) => {
        updates.push(row)
        pendingRow = row
        op = 'update'
        return b
      }
      // await direto no builder (select sem single / update): resultado vazio.
      b.then = (resolve: (v: unknown) => void) => {
        ops.push({ table, op, filters })
        if (table === 'whatsapp_test_sends' && op === 'update' && testSendRow && pendingRow) {
          const row = testSendRow
          const matches = filters.every(([c, v]) => {
            if (c === 'message_id') return row.message_id === v
            if (c === 'status') return row.status === v
            if (c === 'status in') return (v as string[]).includes(row.status)
            if (c === 'status not in') return !String(v).replace(/[()]/g, '').split(',').includes(row.status)
            return true
          })
          if (matches) Object.assign(row, pendingRow)
        }
        resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (cb: () => Promise<void>) => void afterCallbacks.push(cb) }
})
vi.mock('@/lib/audit/context', () => ({
  auditFetch: fetch,
  registerAuditActor: async () => {},
}))
vi.mock('@/lib/logger', () => ({ writeLog: async () => {}, maskPhone: (p: string) => p }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => {} }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: async () => {} }))
vi.mock('@/lib/ai/sentiment-trigger', () => ({ maybeScheduleSentiment: () => {} }))
vi.mock('@/lib/disparador/reply-tracker', () => ({ recordCampaignReply: async () => {} }))
vi.mock('@/lib/webchat/campaign', () => ({ maybeStartCampaignWebchat: async () => {} }))
vi.mock('@/lib/storage/chat-media', () => ({ chatMediaReference: () => null }))

const { POST } = await import('./route')

const CHANNEL_SECRET = 'channel-app-secret-0123456789abcdef'
const GLOBAL_SECRET = process.env.META_APP_SECRET! // "test-meta-app-secret" (vitest.config)

const body = JSON.stringify({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PNID-1' } } }] }],
})

function sign(secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function req(signature: string): Request {
  return new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST',
    body,
    headers: { 'x-hub-signature-256': signature },
  })
}

describe('POST /api/whatsapp/webhook — app_secret por canal', () => {
  beforeEach(() => {
    storedAppSecret = null
    updates.length = 0
    selectCalls = 0
    ops.length = 0
    rpcCalls.length = 0
    afterCallbacks.length = 0
    testSendRow = null
    for (const k of Object.keys(extraChannels)) delete extraChannels[k]
    clearAppSecretCache()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('app_secret cifrado: aceita assinatura com o segredo do canal', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
  })

  it('app_secret cifrado: rejeita assinatura com o segredo global (sem fallback)', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(GLOBAL_SECRET)))).status).toBe(401)
  })

  it('app_secret legado em texto puro: é usado como segredo do canal', async () => {
    storedAppSecret = CHANNEL_SECRET
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
  })

  it('app_secret legado em texto puro desatualizado: mantém o fallback global de antes', async () => {
    storedAppSecret = 'valor-legado-desatualizado'
    expect((await POST(req(sign(GLOBAL_SECRET)))).status).toBe(200)
  })

  it('assinatura inválida continua rejeitada com app_secret legado', async () => {
    storedAppSecret = CHANNEL_SECRET
    expect((await POST(req(sign('outro-segredo')))).status).toBe(401)
  })

  it('canal sem app_secret: usa META_APP_SECRET', async () => {
    storedAppSecret = null
    expect((await POST(req(sign(GLOBAL_SECRET)))).status).toBe(200)
  })

  it('cache: segundo POST do mesmo canal não vai ao banco', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
    expect(selectCalls).toBe(1)
  })

  it('cache: assinatura inválida com segredo em cache relê o banco uma vez (rotação)', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    expect((await POST(req(sign(CHANNEL_SECRET)))).status).toBe(200)
    const ROTATED = 'segredo-rotacionado-0123456789abcdef'
    storedAppSecret = encrypt(ROTATED)
    expect((await POST(req(sign(ROTATED)))).status).toBe(200)
    expect(selectCalls).toBe(2)
    expect((await POST(req(sign('outro-segredo')))).status).toBe(401)
  })

  // ── C-2: injeção cross-tenant ─────────────────────────────────────────
  const SECRET_B = 'app-secret-da-conta-B-0123456789abcdef'

  function crossBody(): string {
    const status = (id: string) => ({ id, status: 'delivered', timestamp: '1', recipient_id: '5511' })
    return JSON.stringify({
      entry: [
        {
          id: 'WABA-A',
          changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID-1' }, statuses: [status('wamid-A')] } }],
        },
        {
          id: 'WABA-B',
          changes: [
            { field: 'messages', value: { metadata: { phone_number_id: 'PNID-B' }, statuses: [status('wamid-B')] } },
            { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 'tpl-B' } },
          ],
        },
      ],
    })
  }

  function postRaw(raw: string, secret: string): Request {
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
    return new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      body: raw,
      headers: { 'x-hub-signature-256': sig },
    })
  }

  async function runAfter() {
    for (const cb of afterCallbacks) await cb()
  }

  it('POST assinado pelo app A com número da conta B: nada da conta B é processado', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET) // conta A (PNID-1 / ACC-1)
    extraChannels['PNID-B'] = { id: 'CFG-B', account_id: 'ACC-B', app_secret: encrypt(SECRET_B) }

    const res = await POST(postRaw(crossBody(), CHANNEL_SECRET))
    expect(res.status).toBe(200) // A validou; B é descartado
    await runAfter()

    expect(rpcCalls.map((c) => c.args.p_message_id)).toEqual(['wamid-A'])
    const touchedAccounts = ops
      .flatMap((o) => o.filters)
      .filter(([c]) => c === 'conversations.account_id')
      .map(([, v]) => v)
    expect(touchedAccounts).toEqual(['ACC-1'])
    expect(JSON.stringify(ops)).not.toContain('wamid-B')
    expect(JSON.stringify(ops)).not.toContain('tpl-B')
    expect(JSON.stringify(ops)).not.toContain('ACC-B')
  })

  it('POST em que nenhum canal valida: 401 e nada processado', async () => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    extraChannels['PNID-B'] = { id: 'CFG-B', account_id: 'ACC-B', app_secret: encrypt(SECRET_B) }
    const res = await POST(postRaw(crossBody(), 'segredo-do-atacante'))
    expect(res.status).toBe(401)
    expect(afterCallbacks.length).toBe(0)
  })

  it('cada canal valida com o próprio segredo: ambos processados nas suas contas', async () => {
    // Mesmo corpo não pode ter duas assinaturas, então um corpo com dois apps
    // legítimos só valida o canal cujo segredo assinou — o outro é descartado.
    storedAppSecret = encrypt(CHANNEL_SECRET)
    extraChannels['PNID-B'] = { id: 'CFG-B', account_id: 'ACC-B', app_secret: encrypt(SECRET_B) }
    const res = await POST(postRaw(crossBody(), SECRET_B))
    expect(res.status).toBe(200)
    await runAfter()
    expect(rpcCalls.map((c) => c.args.p_message_id)).toEqual(['wamid-B'])
    expect(JSON.stringify(ops)).not.toContain('ACC-1')
  })
})

// ---------------------------------------------------------------------------
// "Testar canal": a Meta pode mandar failed (131026) E read para o mesmo wamid.
// ---------------------------------------------------------------------------
describe('POST /api/whatsapp/webhook — precedência de status em whatsapp_test_sends', () => {
  const WAMID = 'wamid-test-send'

  function statusBody(status: string, errors?: Array<{ code: number; title: string }>): string {
    return JSON.stringify({
      entry: [
        {
          id: 'WABA-A',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PNID-1' },
                statuses: [{ id: WAMID, status, timestamp: '1', recipient_id: '5511', ...(errors ? { errors } : {}) }],
              },
            },
          ],
        },
      ],
    })
  }

  async function send(status: string, errors?: Array<{ code: number; title: string }>) {
    const raw = statusBody(status, errors)
    const sig = 'sha256=' + crypto.createHmac('sha256', CHANNEL_SECRET).update(raw).digest('hex')
    const res = await POST(
      new Request('http://localhost/api/whatsapp/webhook', {
        method: 'POST',
        body: raw,
        headers: { 'x-hub-signature-256': sig },
      })
    )
    expect(res.status).toBe(200)
    for (const cb of afterCallbacks.splice(0)) await cb()
  }

  const failed131026 = [{ code: 131026, title: 'Message undeliverable' }]

  beforeEach(() => {
    storedAppSecret = encrypt(CHANNEL_SECRET)
    updates.length = 0
    ops.length = 0
    rpcCalls.length = 0
    afterCallbacks.length = 0
    clearAppSecretCache()
    testSendRow = { message_id: WAMID, status: 'sent', erro: null }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('failed depois de read: não muda status nem grava erro', async () => {
    await send('read')
    await send('failed', failed131026)
    expect(testSendRow).toEqual({ message_id: WAMID, status: 'read', erro: null })
  })

  it('failed depois de delivered: continua delivered', async () => {
    await send('delivered')
    await send('failed', failed131026)
    expect(testSendRow).toEqual({ message_id: WAMID, status: 'delivered', erro: null })
  })

  it('read depois de failed: vira read e limpa o erro', async () => {
    await send('failed', failed131026)
    expect(testSendRow).toEqual({
      message_id: WAMID,
      status: 'failed',
      erro: 'Meta: Message undeliverable (code 131026)',
    })
    await send('read')
    expect(testSendRow).toEqual({ message_id: WAMID, status: 'read', erro: null })
  })

  it('delivered depois de failed: vira delivered e limpa o erro; read segue', async () => {
    await send('failed', failed131026)
    await send('delivered')
    expect(testSendRow).toEqual({ message_id: WAMID, status: 'delivered', erro: null })
    await send('read')
    expect(testSendRow?.status).toBe('read')
  })

  it('sent atrasado não rebaixa read; failed sozinho continua gravando o erro', async () => {
    await send('read')
    await send('sent')
    expect(testSendRow?.status).toBe('read')

    testSendRow = { message_id: WAMID, status: 'sent', erro: null }
    await send('failed')
    expect(testSendRow).toEqual({ message_id: WAMID, status: 'failed', erro: 'Falha na entrega (Meta)' })
  })
})
