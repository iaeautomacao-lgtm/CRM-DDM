import { beforeEach, describe, expect, it, vi } from 'vitest'

// D-17: o UPDATE do bloqueio por blacklist confere o resultado. Falha de gravação = erro técnico retentável (nada é enviado, a
// métrica não conta um bloqueio que não foi gravado); item que já saiu de 'enviando' não é contado duas vezes.
const state = vi.hoisted(() => ({
  blockResult: { data: [{ id: 'item' }] as Array<{ id: string }> | null, error: null as null | { message: string } },
  updates: [] as Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  rpc: vi.fn(async () => ({ data: null, error: null })),
  send: vi.fn(),
}))

vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: state.rpc,
    from: () => {
      const filters: Array<[string, unknown]> = []
      let values: Record<string, unknown> | null = null
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'order', 'limit', 'lte', 'is', 'or']) b[m] = () => b
      b.eq = (c: string, v: unknown) => (filters.push([c, v]), b)
      b.update = (v: Record<string, unknown>) => ((values = v), state.updates.push({ values: v, filters }), b)
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(values ? state.blockResult : { data: null, error: null }).then(resolve)
      return b
    },
  }),
}))
vi.mock('@/lib/logger', () => ({ writeLog: vi.fn(), maskPhone: () => 'masked' }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()), sendTextMessage: state.send }))

import { processQueueItem, type QueueItem } from './processQueue'

const item: QueueItem = {
  id: 'item', campaign_id: 'campaign', contact_id: 'contact', session_id: 'channel', tipo: 'texto', mensagem_final: 'oi', contacts: { phone: '5511999999999' },
}
const run = () => processQueueItem(item, { id: 'campaign', status: 'em_execucao' }, { channelConfig: {}, blacklistLookup: () => true, alreadyClaimed: true })

beforeEach(() => {
  state.blockResult = { data: [{ id: 'item' }], error: null }
  state.updates.length = 0
  state.rpc.mockClear()
  state.send.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('bloqueio por blacklist (D-17)', () => {
  it('só bloqueia item que ainda está em enviando e conta a métrica uma vez', async () => {
    expect(await run()).toEqual({ outcome: 'blocked', reason: 'blacklisted' })
    expect(state.updates[0].values).toEqual({ status: 'bloqueado', erro: 'Número na Blacklist' })
    expect(state.updates[0].filters).toEqual([['id', 'item'], ['status', 'enviando']])
    expect(state.rpc).toHaveBeenCalledWith('increment_campaign_metric', { p_campaign_id: 'campaign', p_field: 'total_blacklist' })
    expect(state.send).not.toHaveBeenCalled()
  })

  it('falha ao gravar o bloqueio: erro retentável, não conta a métrica e não envia', async () => {
    state.blockResult = { data: null, error: { message: 'timeout do banco' } }
    const result = await run()
    expect(result).toMatchObject({ outcome: 'error', error: expect.stringContaining('timeout do banco') })
    expect(state.rpc).not.toHaveBeenCalledWith('increment_campaign_metric', expect.anything())
    expect(state.send).not.toHaveBeenCalled()
    // markQueueError grava o erro como NÃO permanente (o próximo tick confere a blacklist de novo)
    expect(state.updates.some((u) => u.values.status === 'erro' && u.values.erro_permanente !== true)).toBe(true)
  })

  it('item que já saiu de enviando (nenhuma linha atualizada): bloqueado, sem contar a métrica de novo', async () => {
    state.blockResult = { data: [], error: null }
    expect(await run()).toEqual({ outcome: 'blocked', reason: 'blacklisted' })
    expect(state.rpc).not.toHaveBeenCalledWith('increment_campaign_metric', expect.anything())
    expect(state.send).not.toHaveBeenCalled()
  })
})
