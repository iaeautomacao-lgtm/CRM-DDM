import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_META_TIMEOUT_MS, getMetaTimeoutMs } from './meta-api'

// Decisão do dono (13/10): timeout padrão da Meta de 10 s; META_TIMEOUT_MS continua sobrepondo.
afterEach(() => vi.unstubAllEnvs())

describe('timeout da Meta', () => {
  it('padrão é 10 s', () => {
    vi.stubEnv('META_TIMEOUT_MS', '')
    expect(DEFAULT_META_TIMEOUT_MS).toBe(10_000)
    expect(getMetaTimeoutMs()).toBe(10_000)
  })

  it('a variável sobrepõe (incidente), com piso de 1 ms e teto de 120 s; valor inválido volta ao padrão', () => {
    vi.stubEnv('META_TIMEOUT_MS', '20000')
    expect(getMetaTimeoutMs()).toBe(20_000)
    vi.stubEnv('META_TIMEOUT_MS', '999999')
    expect(getMetaTimeoutMs()).toBe(120_000)
    vi.stubEnv('META_TIMEOUT_MS', '0')
    expect(getMetaTimeoutMs()).toBe(10_000)
    vi.stubEnv('META_TIMEOUT_MS', 'abc')
    expect(getMetaTimeoutMs()).toBe(10_000)
  })
})
