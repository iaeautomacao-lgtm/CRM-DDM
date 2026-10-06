import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_SECRET_CACHE_TTL_MS,
  cacheStoredAppSecret,
  clearAppSecretCache,
  getCachedStoredAppSecret,
  invalidateAppSecret,
  processStatusesIndependently,
  shouldProcessStatus,
} from './webhook-fast-path'

describe('cache de app_secret', () => {
  beforeEach(() => clearAppSecretCache())

  it('devolve o valor dentro do TTL e expira depois', () => {
    cacheStoredAppSecret('P1', 'seg', 1_000)
    expect(getCachedStoredAppSecret('P1', 1_000 + APP_SECRET_CACHE_TTL_MS - 1)).toBe('seg')
    expect(getCachedStoredAppSecret('P1', 1_000 + APP_SECRET_CACHE_TTL_MS)).toBeUndefined()
  })

  it('é por phone_number_id e pode ser invalidado', () => {
    cacheStoredAppSecret('P1', 'a')
    expect(getCachedStoredAppSecret('P2')).toBeUndefined()
    invalidateAppSecret('P1')
    expect(getCachedStoredAppSecret('P1')).toBeUndefined()
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
