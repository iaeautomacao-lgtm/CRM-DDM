import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from './encryption'

const processMessage = vi.fn()
const writeLog = vi.fn(async () => {})
vi.mock('@/lib/whatsapp/inbound-message', () => ({ processMessage: (...a: unknown[]) => processMessage(...a) }))
vi.mock('@/lib/logger', () => ({ writeLog: (...a: unknown[]) => (writeLog as unknown as (...x: unknown[]) => unknown)(...a), maskPhone: (p: string) => p }))

import { createInboxProcessor, drainMessageInboxLive, INBOX_CHANNEL_COLUMNS } from './message-inbox-runner'
import type { InboxRow } from './message-inbox'

const CHANNEL = { id: 'CH-1', account_id: 'ACC-1', user_id: 'USER-1', access_token: encrypt('tok-secreto') }
const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  id: 1,
  account_id: 'ACC-1',
  channel_id: 'CH-1',
  message_id: 'wamid.1',
  attempts: 1,
  payload: { message: { id: 'wamid.1', from: '5511', type: 'text', timestamp: '1760000000' }, contact: { profile: { name: 'Maria' }, wa_id: '5511' }, phone_number_id: 'PN1' },
  ...over,
})
function fakeDb(config: unknown[] | null, rpc: (fn: string, args?: Record<string, unknown>) => unknown = () => ({ data: true, error: null })) {
  const selects: string[] = []
  return {
    selects,
    db: {
      rpc: async (fn: string, args?: Record<string, unknown>) => rpc(fn, args) as { data: unknown; error: null },
      from: () => ({
        select: (cols: string) => (selects.push(cols), { eq: () => ({ limit: async () => ({ data: config, error: null }) }) }),
      }),
    },
  }
}

beforeEach(() => {
  processMessage.mockReset()
  writeLog.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('createInboxProcessor', () => {
  it('relê o canal (token nunca no inbox) e chama o processamento de sempre com conta/dono/token decifrado', async () => {
    processMessage.mockResolvedValue('processed')
    const { db, selects } = fakeDb([CHANNEL])
    expect(await createInboxProcessor(db)(row())).toBe('processed')
    expect(selects).toEqual([INBOX_CHANNEL_COLUMNS])
    expect(processMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'wamid.1' }), expect.objectContaining({ wa_id: '5511' }), 'ACC-1', 'USER-1', 'tok-secreto', 'CH-1')
  })

  it('mensagem já gravada (23505 no processamento) = duplicate, sem duplicar', async () => {
    processMessage.mockResolvedValue('duplicate')
    expect(await createInboxProcessor(fakeDb([CHANNEL]).db)(row())).toBe('duplicate')
  })

  it('canal apagado ou de outra conta: falha (vai para backoff/dead), nada é processado', async () => {
    await expect(createInboxProcessor(fakeDb([]).db)(row())).rejects.toThrow(/não encontrado/)
    await expect(createInboxProcessor(fakeDb([{ ...CHANNEL, account_id: 'OUTRA' }]).db)(row())).rejects.toThrow(/diverge/)
    expect(processMessage).not.toHaveBeenCalled()
  })

  it('lê o canal uma vez por lote, mesmo com várias mensagens do mesmo canal', async () => {
    processMessage.mockResolvedValue('processed')
    const { db, selects } = fakeDb([CHANNEL])
    const run = createInboxProcessor(db)
    await Promise.all([run(row({ id: 1 })), run(row({ id: 2, message_id: 'wamid.2' }))])
    expect(selects).toHaveLength(1)
  })
})

describe('drainMessageInboxLive', () => {
  it('esgotou as tentativas: log de erro (alerta) com a conta e o wamid', async () => {
    processMessage.mockRejectedValue(new Error('CHECK content_type'))
    const { db } = fakeDb([CHANNEL], (fn) => {
      if (fn === 'claim_message_inbox') return { data: [row({ attempts: 8 })], error: null }
      if (fn === 'fail_message_inbox') return { data: 'dead', error: null }
      return { data: null, error: null }
    })
    const summary = await drainMessageInboxLive(db, { limit: 5, maxBatches: 1 })
    expect(summary).toMatchObject({ failed: 1, dead: 1 })
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'message_inbox_dead', level: 'error', account_id: 'ACC-1' }))
  })
})
