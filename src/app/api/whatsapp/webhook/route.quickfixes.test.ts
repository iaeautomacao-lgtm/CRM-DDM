// PRD 15 — quickfixes do webhook Meta (WH-03/04/06/14), caminho inline.
import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { clearAppSecretCache } from '@/lib/whatsapp/webhook-fast-path'
import { resetStatusInboxState } from '@/lib/whatsapp/status-inbox'
import { resetMessageInboxState } from '@/lib/whatsapp/message-inbox'

const SECRET = 'channel-app-secret-0123456789abcdef'
const afterCallbacks: Array<() => Promise<void>> = []
const processMessage = vi.fn()
const writeLog = vi.fn(async () => {})
const configSelects: Array<{ columns: string; phone: unknown }> = []
// access_token por phone_number_id: PNID-BAD tem token que não decifra.
const tokens: Record<string, string> = { 'PNID-OK': encrypt('tok'), 'PNID-BAD': 'isto-nao-e-um-token-cifrado' }

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ data: true, error: null }),
    from: () => {
      let columns = ''
      let phone: unknown = null
      const b: Record<string, unknown> = {}
      for (const m of ['limit', 'neq', 'order']) b[m] = () => b
      b.select = (c: string) => ((columns = c), b)
      b.eq = (c: string, v: unknown) => {
        if (c === 'phone_number_id') phone = v
        return b
      }
      b.single = async () => ({ data: { id: `CFG-${String(phone)}`, account_id: 'ACC-1', app_secret: encrypt(SECRET) }, error: null })
      b.then = (resolve: (v: unknown) => void) => {
        configSelects.push({ columns, phone })
        resolve({
          data: [{ id: `CFG-${String(phone)}`, account_id: 'ACC-1', user_id: 'USER-1', access_token: tokens[String(phone)] }],
          error: null,
        })
      }
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
vi.mock('@/lib/whatsapp/message-inbox-runner', () => ({ drainMessageInboxLive: async () => ({ claimed: 0 }) }))
vi.mock('@/lib/ai/sentiment-trigger', () => ({ maybeScheduleSentiment: () => {} }))

const { POST } = await import('./route')

const contactA = { profile: { name: 'Cliente A' }, wa_id: '5511999990001' }
const contactB = { profile: { name: 'Cliente B' }, wa_id: '5511999990002' }
const m = (id: string, from: string) => ({ id, from, timestamp: '1760000000', type: 'text', text: { body: 'oi' } })

function post(changes: Array<{ phone: string; contacts?: unknown[]; messages?: unknown[]; errors?: unknown[] }>): Request {
  const raw = JSON.stringify({
    entry: [
      {
        id: 'WABA-A',
        changes: changes.map((c) => ({
          field: 'messages',
          value: {
            metadata: { phone_number_id: c.phone, display_phone_number: '1' },
            ...(c.contacts ? { contacts: c.contacts } : {}),
            ...(c.messages ? { messages: c.messages } : {}),
            ...(c.errors ? { errors: c.errors } : {}),
          },
        })),
      },
    ],
  })
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex')
  return new Request('http://localhost/api/whatsapp/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } })
}
const runAfter = async () => {
  for (const cb of afterCallbacks.splice(0)) await cb()
}

describe('POST /api/whatsapp/webhook — quickfixes (inline)', () => {
  beforeEach(() => {
    afterCallbacks.length = 0
    configSelects.length = 0
    processMessage.mockReset()
    processMessage.mockResolvedValue('processed')
    writeLog.mockClear()
    clearAppSecretCache()
    resetStatusInboxState()
    resetMessageInboxState()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.WHATSAPP_MESSAGE_INBOX
  })

  it('WH-03: token que não decifra derruba só aquela change; a seguinte é processada e o erro fica no log', async () => {
    const res = await POST(
      post([
        { phone: 'PNID-BAD', contacts: [contactA], messages: [m('wamid.bad', contactA.wa_id)] },
        { phone: 'PNID-OK', contacts: [contactB], messages: [m('wamid.ok', contactB.wa_id)] },
      ]),
    )
    expect(res.status).toBe(200)
    await runAfter()
    expect(processMessage).toHaveBeenCalledTimes(1)
    expect((processMessage.mock.calls[0][0] as { id: string }).id).toBe('wamid.ok')
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'access_token_decrypt_failed', account_id: 'ACC-1' }))
  })

  it('WH-04: cada mensagem recebe o contato do próprio wa_id (ordem invertida, lista menor que a de mensagens)', async () => {
    await POST(
      post([
        {
          phone: 'PNID-OK',
          contacts: [contactB],
          messages: [m('wamid.1', contactA.wa_id), m('wamid.2', contactB.wa_id), m('wamid.3', '5521988880000')],
        },
      ]),
    )
    await runAfter()
    const contactOf = (id: string) => processMessage.mock.calls.find((c) => (c[0] as { id: string }).id === id)?.[1]
    expect(contactOf('wamid.1')).toBeNull() // A não herda o nome de B
    expect(contactOf('wamid.2')).toEqual(contactB)
    expect(contactOf('wamid.3')).toBeNull()
    expect(processMessage).toHaveBeenCalledTimes(3)
  })

  it('WH-06: value.errors da Meta vai para o log (sem derrubar o POST)', async () => {
    const res = await POST(
      post([{ phone: 'PNID-OK', errors: [{ code: 131051, title: 'Unsupported message type', error_data: { details: 'tipo x' } }] }]),
    )
    expect(res.status).toBe(200)
    await runAfter()
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'meta_value_errors',
        level: 'warn',
        payload: expect.objectContaining({ errors: [expect.objectContaining({ code: 131051, details: 'tipo x' })] }),
      }),
    )
  })

  it('WH-14: a linha do canal é lida UMA vez por phone_number_id (duas changes) e sem coluna curinga', async () => {
    await POST(
      post([
        { phone: 'PNID-OK', contacts: [contactA], messages: [m('wamid.1', contactA.wa_id)] },
        { phone: 'PNID-OK', contacts: [contactB], messages: [m('wamid.2', contactB.wa_id)] },
      ]),
    )
    await runAfter()
    const processSelects = configSelects.filter((s) => s.columns.includes('access_token'))
    expect(processSelects).toHaveLength(1)
    expect(processSelects[0].columns).not.toBe('*')
    expect(processSelects[0].columns).not.toMatch(/app_secret|verify_token/)
    expect(processMessage).toHaveBeenCalledTimes(2)
  })
})
