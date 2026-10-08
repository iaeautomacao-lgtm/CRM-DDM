// Webhook da Meta × inbox durável de MENSAGENS (migration 201, WHATSAPP_MESSAGE_INBOX = off | shadow | on).
// Aqui só o contrato da rota; a fila em si (duplicata, lease, ordem, dead) está em lib/whatsapp/message-inbox.sql.test.ts.
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { clearAppSecretCache } from '@/lib/whatsapp/webhook-fast-path'
import { resetStatusInboxState } from '@/lib/whatsapp/status-inbox'
import { resetMessageInboxState } from '@/lib/whatsapp/message-inbox'

const SECRET = 'channel-app-secret-0123456789abcdef'
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
const afterCallbacks: Array<() => Promise<void>> = []
const processMessage = vi.fn()
const drainLive = vi.fn(async (_db: unknown, _options: unknown) => ({ claimed: 0 }))
const writeLog = vi.fn(async () => {})
let ingestResult: { data?: unknown; error?: { code?: string; message: string } | null } = {}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === 'ingest_message_events') {
        if (ingestResult.error) return { data: null, error: ingestResult.error }
        const events = args.p_events as Array<{ message_id: string }>
        return { data: ingestResult.data ?? { inserted: events.length, ids: events.map((_, i) => i + 1) }, error: null }
      }
      return { data: true, error: null }
    },
    from: () => {
      const filters: Array<[string, unknown]> = []
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'limit', 'neq', 'order']) b[m] = () => b
      b.eq = (c: string, v: unknown) => (filters.push([c, v]), b)
      const config = { id: 'CFG-1', account_id: 'ACC-1', user_id: 'USER-1', access_token: encrypt('tok') }
      b.single = async () => ({ data: { id: 'CFG-1', account_id: 'ACC-1', app_secret: encrypt(SECRET) }, error: null })
      b.then = (resolve: (v: unknown) => void) => resolve({ data: [config], error: null })
      return b
    },
  }),
}))
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (cb: () => Promise<void>) => void afterCallbacks.push(cb) }
})
vi.mock('@/lib/audit/context', () => ({ auditFetch: fetch, registerAuditActor: async () => {} }))
vi.mock('@/lib/logger', () => ({ writeLog: (...a: unknown[]) => (writeLog as unknown as (...x: unknown[]) => unknown)(...a), maskPhone: (p: string) => p }))
vi.mock('@/lib/whatsapp/inbound-message', () => ({ processMessage: (...a: unknown[]) => processMessage(...a) }))
vi.mock('@/lib/whatsapp/message-inbox-runner', () => ({ drainMessageInboxLive: (...a: unknown[]) => (drainLive as unknown as (...x: unknown[]) => unknown)(...a) }))
vi.mock('@/lib/ai/sentiment-trigger', () => ({ maybeScheduleSentiment: () => {} }))

const { POST } = await import('./route')

const msg = (id: string, from = '5511999990001') => ({ id, from, timestamp: '1760000000', type: 'text', text: { body: 'oi' } })
function messagePost(messages: unknown[]): Request {
  const raw = JSON.stringify({
    entry: [
      {
        id: 'WABA-A',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PNID-1', display_phone_number: '1' },
              contacts: [{ profile: { name: 'Maria' }, wa_id: '5511999990001' }],
              messages,
            },
          },
        ],
      },
    ],
  })
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex')
  return new Request('http://localhost/api/whatsapp/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } })
}
const runAfter = async () => {
  for (const cb of afterCallbacks.splice(0)) await cb()
}
const ingests = () => rpcCalls.filter((c) => c.fn === 'ingest_message_events')

describe('POST /api/whatsapp/webhook — inbox de mensagens (WHATSAPP_MESSAGE_INBOX)', () => {
  beforeEach(() => {
    rpcCalls.length = 0
    afterCallbacks.length = 0
    processMessage.mockReset()
    processMessage.mockResolvedValue('processed')
    drainLive.mockClear()
    writeLog.mockClear()
    ingestResult = {}
    clearAppSecretCache()
    resetStatusInboxState()
    resetMessageInboxState()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.WHATSAPP_MESSAGE_INBOX
  })
  afterEach(() => {
    delete process.env.WHATSAPP_MESSAGE_INBOX
  })

  it('off (padrão): comportamento de sempre — processa inline, sem tocar no inbox', async () => {
    expect((await POST(messagePost([msg('wamid.1')]))).status).toBe(200)
    await runAfter()
    expect(ingests()).toHaveLength(0)
    expect(processMessage).toHaveBeenCalledTimes(1)
    expect(drainLive).not.toHaveBeenCalled()
  })

  it('shadow: grava no inbox (estado shadow) E processa como hoje — uma vez só, sem drenador', async () => {
    process.env.WHATSAPP_MESSAGE_INBOX = 'shadow'
    expect((await POST(messagePost([msg('wamid.1'), msg('wamid.2')]))).status).toBe(200)
    expect(ingests()).toHaveLength(1)
    expect(ingests()[0].args.p_state).toBe('shadow')
    await runAfter()
    expect(processMessage).toHaveBeenCalledTimes(2) // 1 por mensagem: nunca duas vezes
    expect(drainLive).not.toHaveBeenCalled()
  })

  it('shadow: falha ao gravar o espelho NÃO derruba o POST (o caminho antigo é a verdade)', async () => {
    process.env.WHATSAPP_MESSAGE_INBOX = 'shadow'
    ingestResult = { error: { code: '57014', message: 'statement timeout' } }
    expect((await POST(messagePost([msg('wamid.1')]))).status).toBe(200)
    await runAfter()
    expect(processMessage).toHaveBeenCalledTimes(1)
  })

  it('on: grava ANTES do 200, o processamento sai do caminho inline e o drenador recebe os ids do POST', async () => {
    process.env.WHATSAPP_MESSAGE_INBOX = 'on'
    const res = await POST(messagePost([msg('wamid.1'), msg('wamid.2')]))
    expect(res.status).toBe(200)
    expect(ingests()).toHaveLength(1) // antes do after()
    expect(ingests()[0].args.p_state).toBe('pending')
    const events = ingests()[0].args.p_events as Array<Record<string, unknown>>
    expect(events.map((e) => e.message_id)).toEqual(['wamid.1', 'wamid.2'])
    // conta/canal do canal VERIFICADO; nenhum token no que é gravado
    expect(events.every((e) => e.account_id === 'ACC-1' && e.channel_id === 'CFG-1')).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/access_token|app_secret/)
    await runAfter()
    expect(processMessage).not.toHaveBeenCalled()
    expect(drainLive).toHaveBeenCalledTimes(1)
    expect(drainLive.mock.calls[0][1]).toMatchObject({ ids: [1, 2], requireTurn: true })
  })

  it('on: falha ao gravar no inbox ⇒ 500 (a Meta reenvia) e nada é processado', async () => {
    process.env.WHATSAPP_MESSAGE_INBOX = 'on'
    ingestResult = { error: { code: '57014', message: 'statement timeout' } }
    const res = await POST(messagePost([msg('wamid.1')]))
    expect(res.status).toBe(500)
    expect(afterCallbacks).toHaveLength(0)
    expect(processMessage).not.toHaveBeenCalled()
  })

  it('on com a migration 201 ausente: cai no caminho inline, sem 500', async () => {
    process.env.WHATSAPP_MESSAGE_INBOX = 'on'
    ingestResult = { error: { code: 'PGRST202', message: 'Could not find the function wacrm.ingest_message_events' } }
    expect((await POST(messagePost([msg('wamid.1')]))).status).toBe(200)
    await runAfter()
    expect(processMessage).toHaveBeenCalledTimes(1)
    expect(drainLive).not.toHaveBeenCalled()
  })

  it('valor inválido da env cai no padrão (off)', async () => {
    process.env.WHATSAPP_MESSAGE_INBOX = 'talvez'
    await POST(messagePost([msg('wamid.1')]))
    await runAfter()
    expect(ingests()).toHaveLength(0)
    expect(processMessage).toHaveBeenCalledTimes(1)
  })

  it('caminho inline: uma mensagem que falha não derruba as outras do POST e fica registrada (WH-02/03)', async () => {
    processMessage.mockImplementationOnce(async () => {
      throw new Error('Falha ao gravar a mensagem recebida: CHECK content_type')
    })
    expect((await POST(messagePost([msg('wamid.1'), msg('wamid.2')]))).status).toBe(200)
    await runAfter()
    expect(processMessage).toHaveBeenCalledTimes(2)
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'inbound_message_failed', account_id: 'ACC-1' }))
  })
})
