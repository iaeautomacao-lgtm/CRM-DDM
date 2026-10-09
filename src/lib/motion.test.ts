import { describe, expect, it } from 'vitest'

import { COUNT_UP_MS, countUpValue, easeOutQuart, shouldCountUp } from './motion'

describe('motion: contagem animada (porte do countUp do protótipo)', () => {
  it('easeOutQuart vai de 0 a 1 e desacelera no fim', () => {
    expect(easeOutQuart(0)).toBe(0)
    expect(easeOutQuart(1)).toBe(1)
    expect(easeOutQuart(0.5)).toBeCloseTo(0.9375)
    expect(easeOutQuart(-1)).toBe(0)
    expect(easeOutQuart(2)).toBe(1)
  })

  it('countUpValue interpola entre o valor anterior e o novo', () => {
    expect(countUpValue(0, 100, 0)).toBe(0)
    expect(countUpValue(0, 100, COUNT_UP_MS)).toBe(100)
    expect(countUpValue(200, 100, COUNT_UP_MS)).toBe(100)
    expect(countUpValue(0, 100, COUNT_UP_MS / 2)).toBeCloseTo(93.75)
    expect(countUpValue(5, 9, 10, 0)).toBe(9)
  })

  it('não anima números pequenos nem não finitos (como o protótipo)', () => {
    expect(shouldCountUp(1)).toBe(false)
    expect(shouldCountUp(-1.5)).toBe(false)
    expect(shouldCountUp(Number.NaN)).toBe(false)
    expect(shouldCountUp(Number.POSITIVE_INFINITY)).toBe(false)
    expect(shouldCountUp(2)).toBe(true)
    expect(shouldCountUp(-40)).toBe(true)
  })
})
