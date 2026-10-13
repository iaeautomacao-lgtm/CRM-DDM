import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_CONCURRENCY, MAX_PLAN_CONCURRENCY, mapWithConcurrency, resolvePlanConcurrency } from './plan-concurrency'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('resolvePlanConcurrency', () => {
  it('padrão 4; faixa 1..8; valor inválido volta ao padrão', () => {
    expect(resolvePlanConcurrency({})).toBe(DEFAULT_PLAN_CONCURRENCY)
    expect(resolvePlanConcurrency({ DISPARADOR_PLAN_CONCURRENCY: '1' })).toBe(1)
    expect(resolvePlanConcurrency({ DISPARADOR_PLAN_CONCURRENCY: '99' })).toBe(MAX_PLAN_CONCURRENCY)
    expect(resolvePlanConcurrency({ DISPARADOR_PLAN_CONCURRENCY: '0' })).toBe(1)
    expect(resolvePlanConcurrency({ DISPARADOR_PLAN_CONCURRENCY: 'abc' })).toBe(DEFAULT_PLAN_CONCURRENCY)
  })
})

describe('mapWithConcurrency (D-08)', () => {
  it('devolve o resultado na ORDEM da lista mesmo quando as tarefas terminam fora de ordem (fairness preservada)', async () => {
    const delays = [40, 5, 25, 1, 30, 10]
    const out = await mapWithConcurrency(delays, 4, async (d, i) => (await sleep(d), `c${i}`))
    expect(out).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('nunca passa do limite de tarefas em voo e usa todo o limite quando há trabalho', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++inFlight)
      await sleep(5)
      inFlight--
    })
    expect(peak).toBe(4)
  })

  it('limite 1 = serial, como o laço antigo (uma tarefa por vez, na ordem)', async () => {
    const order: string[] = []
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(`start${n}`)
      await sleep(5)
      order.push(`end${n}`)
    })
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2', 'start3', 'end3'])
  })

  it('a 1ª falha para de iniciar tarefas novas e rejeita com o MESMO erro', async () => {
    const started: number[] = []
    const boom = new Error('rpc caiu')
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
        started.push(n)
        await sleep(5)
        if (n === 1) throw boom
        return n
      }),
    ).rejects.toBe(boom)
    expect(started.length).toBeLessThan(8)
  })

  it('lista vazia e menos itens que o limite', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
    expect(await mapWithConcurrency(['a'], 4, async (x) => x.toUpperCase())).toEqual(['A'])
  })
})
