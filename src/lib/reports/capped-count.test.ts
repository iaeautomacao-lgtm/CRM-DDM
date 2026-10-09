import { describe, expect, it, vi } from 'vitest'
import { cappedTotal } from './capped-count'

const ok = <T,>(v: T) => Promise.resolve({ ...v, error: null })

function make(opts: { probeRows?: number; count?: number }) {
  const probe = vi.fn((_from: number, _to: number) => ok({ data: Array.from({ length: opts.probeRows ?? 0 }, () => ({})) }))
  const exact = vi.fn(() => ok({ count: opts.count ?? 0 }))
  return { probe, exact }
}

describe('cappedTotal', () => {
  it('página curta: total exato sem consultar mais nada', async () => {
    const { probe, exact } = make({})
    expect(await cappedTotal({ pageRows: 7, fromRow: 50, pageSize: 50, probe, exact, cap: 100 })).toEqual({ total: 57, total_capped: false, total_cap: 100 })
    expect(probe).not.toHaveBeenCalled()
    expect(exact).not.toHaveBeenCalled()
  })

  it('lista vazia na página 1: total 0', async () => {
    const { probe, exact } = make({})
    expect((await cappedTotal({ pageRows: 0, fromRow: 0, pageSize: 50, probe, exact, cap: 100 })).total).toBe(0)
    expect(exact).not.toHaveBeenCalled()
  })

  it('página cheia e menos que o teto: sonda e conta exato', async () => {
    const { probe, exact } = make({ probeRows: 0, count: 63 })
    expect(await cappedTotal({ pageRows: 50, fromRow: 0, pageSize: 50, probe, exact, cap: 100 })).toEqual({ total: 63, total_capped: false, total_cap: 100 })
    expect(probe).toHaveBeenCalledWith(100, 100)
  })

  it('bateu no teto: total = teto, capped e sem contagem exata', async () => {
    const { probe, exact } = make({ probeRows: 1 })
    expect(await cappedTotal({ pageRows: 50, fromRow: 0, pageSize: 50, probe, exact, cap: 100 })).toEqual({ total: 100, total_capped: true, total_cap: 100 })
    expect(exact).not.toHaveBeenCalled()
  })

  it('página além do fim (vazia, page > 1): cai na sonda/contagem', async () => {
    const { probe, exact } = make({ probeRows: 0, count: 12 })
    expect((await cappedTotal({ pageRows: 0, fromRow: 100, pageSize: 50, probe, exact, cap: 1000 })).total).toBe(12)
  })

  it('propaga erro da sonda', async () => {
    const probe = () => Promise.resolve({ data: null, error: { message: 'boom' } })
    await expect(cappedTotal({ pageRows: 50, fromRow: 0, pageSize: 50, probe, exact: () => ok({ count: 1 }), cap: 10 })).rejects.toThrow('boom')
  })
})
