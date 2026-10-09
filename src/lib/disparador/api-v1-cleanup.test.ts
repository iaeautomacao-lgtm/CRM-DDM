import { describe, expect, it, vi } from 'vitest'
import { sweepStuckApiCampaigns } from './api-v1-cleanup'

type Call = { table: string; op: string; filters: Array<[string, string, unknown]> }

function fakeDb(stuck: Array<{ id: string; account_id: string }>, readError = false) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] }
    const b: any = {}
    b.select = () => b
    b.eq = (c: string, v: unknown) => (call.filters.push([c, 'eq', v]), b)
    b.lt = (c: string, v: unknown) => (call.filters.push([c, 'lt', v]), b)
    b.limit = () => b
    b.delete = () => ((call.op = 'delete'), b)
    b.update = () => ((call.op = 'update'), b)
    b.then = (resolve: (v: unknown) => void) => {
      calls.push(call)
      if (call.op === 'select') return resolve(readError ? { data: null, error: { message: 'down' } } : { data: stuck, error: null })
      resolve({ error: null })
    }
    return b
  }
  return { db: { from } as any, calls }
}

describe('sweepStuckApiCampaigns (A7)', () => {
  it('lê só api_v1 em rascunho mais antigo que 15 min e desfaz cada uma (fila, métricas, deltas, campanha)', async () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    const { db, calls } = fakeDb([{ id: 'C1', account_id: 'A1' }])
    expect(await sweepStuckApiCampaigns(db, { now: () => now })).toBe(1)
    const read = calls[0]
    expect(read.filters).toEqual(
      expect.arrayContaining([['source', 'eq', 'api_v1'], ['status', 'eq', 'rascunho'], ['created_at', 'lt', '2026-10-09T11:45:00.000Z']]),
    )
    expect(calls.slice(1).map((c) => `${c.op}:${c.table}`)).toEqual([
      'delete:disp_message_queue',
      'delete:campaign_metrics',
      'delete:campaign_metric_deltas',
      'update:campaigns',
    ])
  })

  it('erro de leitura não propaga e não desfaz nada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, calls } = fakeDb([], true)
    expect(await sweepStuckApiCampaigns(db)).toBe(0)
    expect(calls).toHaveLength(1)
  })
})
