import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  drainStatusInbox,
  extractStatusEvents,
  failureReasonOf,
  ingestStatusEvents,
  resetStatusInboxState,
  type StatusEventInput,
} from './status-inbox'
import { allowExpensiveRejection, channelKeyForChange, clearAppSecretCache } from './webhook-fast-path'

const channels = new Map([['pn:PN-A', { id: 'CH-A', account_id: 'ACC-A' }]])
const keyOf = (entry: { id?: string }, change: { field?: string; value?: { metadata?: { phone_number_id?: string } } }) =>
  channelKeyForChange(entry, change, false)
const st = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, status, timestamp: '1760000000', ...extra })
const body = (statuses: unknown[], pn = 'PN-A') => ({
  entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: pn }, statuses } }] }],
})

describe('extractStatusEvents', () => {
  it('só delivered/read/failed de canais verificados; conta e canal vêm do canal, não do corpo', () => {
    const events = extractStatusEvents(
      body([
        st('a', 'delivered'),
        st('b', 'sent'),
        st('c', 'read'),
        st('d', 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] }),
        { status: 'read' },
      ]) as never,
      channels,
      keyOf,
    )
    expect(events.map((e) => [e.message_id, e.status, e.account_id, e.channel_id])).toEqual([
      ['a', 'delivered', 'ACC-A', 'CH-A'],
      ['c', 'read', 'ACC-A', 'CH-A'],
      ['d', 'failed', 'ACC-A', 'CH-A'],
    ])
    expect(events[2].error_text).toBe('Meta: Message undeliverable (code 131026)')
    expect(events[0]).toMatchObject({ error_text: null, ts: 1760000000 })
  })

  it('canal NÃO verificado é descartado por inteiro', () => {
    expect(extractStatusEvents(body([st('a', 'read')], 'PN-OUTRO') as never, channels, keyOf)).toEqual([])
  })

  it('timestamp inválido vira null; failureReasonOf sem erro é null', () => {
    const [e] = extractStatusEvents(body([st('a', 'read', { timestamp: 'x' })]) as never, channels, keyOf)
    expect(e.ts).toBeNull()
    expect(failureReasonOf(undefined)).toBeNull()
  })
})

describe('ingestStatusEvents', () => {
  beforeEach(() => resetStatusInboxState())
  const ev: StatusEventInput[] = [{ message_id: 'a', status: 'read', error_text: null, ts: 1, account_id: 'A', channel_id: 'C' }]

  it('uma chamada por lote; sem eventos não chama', async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }))
    expect(await ingestStatusEvents({ rpc }, ev)).toEqual({ ok: true, inserted: 1 })
    expect(rpc).toHaveBeenCalledWith('ingest_status_events', { p_events: ev })
    expect(await ingestStatusEvents({ rpc }, [])).toEqual({ ok: true, inserted: 0 })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('erro real ⇒ ok:false (o webhook responde 500); função ausente ⇒ missing e recheca só depois de 60 s', async () => {
    const real = vi.fn(async () => ({ data: null, error: { code: '57014', message: 'timeout' } }))
    expect(await ingestStatusEvents({ rpc: real }, ev)).toEqual({ ok: false, missing: false, error: 'timeout' })
    const missing = vi.fn(async () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }))
    expect(await ingestStatusEvents({ rpc: missing }, ev, 1_000)).toEqual({ ok: false, missing: true })
    expect(await ingestStatusEvents({ rpc: missing }, ev, 30_000)).toEqual({ ok: false, missing: true })
    expect(missing).toHaveBeenCalledTimes(1)
    await ingestStatusEvents({ rpc: missing }, ev, 62_000)
    expect(missing).toHaveBeenCalledTimes(2)
  })
})

describe('drainStatusInbox', () => {
  const makeRpc = (turn: boolean, claimed: number[]) => {
    const queue = [...claimed]
    return vi.fn(async (fn: string) => {
      if (fn === 'try_claim_status_drain') return { data: turn, error: null }
      return { data: { claimed: queue.shift() ?? 0, failed: 0 }, error: null }
    })
  }

  it('webhook: precisa ganhar a vez; sem a vez não aplica nada', async () => {
    const rpc = makeRpc(false, [10])
    expect(await drainStatusInbox({ rpc }, { requireTurn: true })).toMatchObject({ batches: 0 })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('continua enquanto o lote vier cheio, respeitando maxBatches e shouldStop', async () => {
    expect(await drainStatusInbox({ rpc: makeRpc(true, [500, 500, 40]) })).toMatchObject({ batches: 3, claimed: 1040 })
    expect(await drainStatusInbox({ rpc: makeRpc(true, [500, 500, 500, 500]) }, { maxBatches: 2 })).toMatchObject({ batches: 2 })
    let calls = 0
    const result = await drainStatusInbox({ rpc: makeRpc(true, [500, 500, 500]) }, { shouldStop: () => ++calls > 1 })
    expect(result.batches).toBe(1)
  })

  it('migration ausente ou erro: não lança e sinaliza', async () => {
    const missing = vi.fn(async () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }))
    expect(await drainStatusInbox({ rpc: missing })).toMatchObject({ missing: true, batches: 0 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = vi.fn(async () => {
      throw new Error('rede')
    })
    expect(await drainStatusInbox({ rpc: broken })).toMatchObject({ batches: 0 })
  })
})

describe('allowExpensiveRejection (cache negativo, W4)', () => {
  beforeEach(() => clearAppSecretCache())
  it('primeira ocorrência da chave por janela passa; as demais não; depois da janela volta', () => {
    expect(allowExpensiveRejection('k', 1_000)).toBe(true)
    expect(allowExpensiveRejection('k', 2_000)).toBe(false)
    expect(allowExpensiveRejection('outra', 2_000)).toBe(true)
    expect(allowExpensiveRejection('k', 31_001)).toBe(true)
  })
})
