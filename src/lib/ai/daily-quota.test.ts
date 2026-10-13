import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeAiQuota, DEFAULT_AI_DAILY_LIMITS } from './daily-quota'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('consumeAiQuota', () => {
  it('manda o padrão do tipo à RPC e devolve a decisão do banco', async () => {
    const rpc = vi.fn(async () => ({ data: { allowed: true, used: 3, limit: 10000 }, error: null }))
    const r = await consumeAiQuota({ rpc }, 'acc-1', 'stt')
    expect(r).toEqual({ allowed: true, used: 3, limit: 10000 })
    expect(rpc).toHaveBeenCalledWith('consume_ai_quota', { p_account: 'acc-1', p_kind: 'stt', p_default_limit: DEFAULT_AI_DAILY_LIMITS.stt })
  })

  it('cota esgotada devolve allowed=false com o uso', async () => {
    const rpc = async () => ({ data: { allowed: false, used: 5000, limit: 5000 }, error: null })
    expect(await consumeAiQuota({ rpc }, 'acc-1', 'tag_suggest')).toEqual({ allowed: false, used: 5000, limit: 5000 })
  })

  it('o padrão é generoso: milhares por dia', () => {
    expect(DEFAULT_AI_DAILY_LIMITS.stt).toBeGreaterThanOrEqual(5000)
    expect(DEFAULT_AI_DAILY_LIMITS.tag_suggest).toBeGreaterThanOrEqual(1000)
  })

  it('fail-open: RPC ausente (migration 339 não aplicada), erro, resposta estranha ou exceção deixam passar', async () => {
    expect((await consumeAiQuota({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }, 'a', 'stt')).allowed).toBe(true)
    expect((await consumeAiQuota({ rpc: async () => ({ data: null, error: { code: '42883' } }) }, 'a', 'stt')).allowed).toBe(true)
    expect((await consumeAiQuota({ rpc: async () => ({ data: null, error: { code: 'XX000', message: 'x' } }) }, 'a', 'stt')).allowed).toBe(true)
    expect((await consumeAiQuota({ rpc: async () => ({ data: 'lixo', error: null }) }, 'a', 'stt')).allowed).toBe(true)
    expect((await consumeAiQuota({ rpc: () => { throw new Error('queda') } }, 'a', 'stt')).allowed).toBe(true)
    expect((await consumeAiQuota({}, 'a', 'stt')).allowed).toBe(true)
    expect((await consumeAiQuota(null, 'a', 'stt')).allowed).toBe(true)
  })
})
