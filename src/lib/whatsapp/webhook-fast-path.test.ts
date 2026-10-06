import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_SECRET_CACHE_TTL_MS,
  cacheChannel,
  channelKeyForChange,
  clearAppSecretCache,
  getCachedChannel,
  invalidateChannel,
  processStatusesIndependently,
  shouldProcessStatus,
} from './webhook-fast-path'

const ROW = { id: 'c1', account_id: 'a1', app_secret: 'seg' }

describe('cache de canal', () => {
  beforeEach(() => clearAppSecretCache())

  it('devolve o valor dentro do TTL e expira depois', () => {
    cacheChannel('pn:P1', ROW, 1_000)
    expect(getCachedChannel('pn:P1', 1_000 + APP_SECRET_CACHE_TTL_MS - 1)).toBe(ROW)
    expect(getCachedChannel('pn:P1', 1_000 + APP_SECRET_CACHE_TTL_MS)).toBeUndefined()
  })

  it('é por chave e pode ser invalidado', () => {
    cacheChannel('pn:P1', ROW)
    expect(getCachedChannel('pn:P2')).toBeUndefined()
    invalidateChannel('pn:P1')
    expect(getCachedChannel('pn:P1')).toBeUndefined()
  })
})

describe('channelKeyForChange', () => {
  it('template usa o WABA da entry; demais usam o phone_number_id', () => {
    expect(channelKeyForChange({ id: 'W1' }, {}, true)).toBe('waba:W1')
    expect(
      channelKeyForChange({ id: 'W1' }, { value: { metadata: { phone_number_id: 'P1' } } }, false),
    ).toBe('pn:P1')
    expect(channelKeyForChange({ id: 'W1' }, { value: {} }, false)).toBeNull()
  })
})

describe('status do webhook', () => {
  it('ignora sent e status desconhecidos', () => {
    expect(shouldProcessStatus('sent')).toBe(false)
    expect(shouldProcessStatus('deleted')).toBe(false)
    for (const s of ['delivered', 'read', 'failed']) {
      expect(shouldProcessStatus(s)).toBe(true)
    }
  })

  it('erro em um status não derruba os outros', async () => {
    const seen: string[] = []
    const errors: string[] = []
    const failures = await processStatusesIndependently(
      [
        { id: '1', status: 'sent' },
        { id: '2', status: 'delivered' },
        { id: '3', status: 'read' },
        { id: '4', status: 'failed' },
      ],
      async (s) => {
        if (s.id === '2') throw new Error('boom')
        seen.push(s.id)
      },
      (s) => errors.push(s.id),
    )
    expect(seen).toEqual(['3', '4'])
    expect(errors).toEqual(['2'])
    expect(failures).toBe(1)
  })
})
