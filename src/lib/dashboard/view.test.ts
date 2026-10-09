import { describe, expect, it } from 'vitest'
import {
  dayKeyLabel,
  deltaTone,
  formatDelta,
  formatMinutes,
  niceAxisTop,
  pct,
  relativeShort,
  updatedLabel,
  xLabelIndexes,
} from './view'

describe('deltaTone', () => {
  it('subir é bom ou ruim conforme a métrica', () => {
    expect(deltaTone(3, true)).toBe('up-good')
    expect(deltaTone(3, false)).toBe('up-bad')
    expect(deltaTone(-3, true)).toBe('down-bad')
    expect(deltaTone(-3, false)).toBe('down-good')
    expect(deltaTone(0, true)).toBe('flat')
    expect(deltaTone(Number.NaN, true)).toBe('flat')
  })
})

describe('formatDelta', () => {
  it('usa sinal e separador pt-BR', () => {
    expect(formatDelta(1234)).toBe('+1.234')
    expect(formatDelta(-3)).toBe('−3')
    expect(formatDelta(0)).toBe('0')
  })
})

describe('formatMinutes', () => {
  it('formata segundos, minutos e horas', () => {
    expect(formatMinutes(null)).toBe('—')
    expect(formatMinutes(0.75)).toBe('45s')
    expect(formatMinutes(3.7)).toBe('3m 42s')
    expect(formatMinutes(5)).toBe('5m')
    expect(formatMinutes(65)).toBe('1h 05m')
  })
})

describe('relativeShort / updatedLabel', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  it('tempo relativo curto', () => {
    expect(relativeShort('2026-10-09T11:59:40Z', now)).toBe('agora')
    expect(relativeShort('2026-10-09T11:54:00Z', now)).toBe('6 min')
    expect(relativeShort('2026-10-09T09:00:00Z', now)).toBe('3 h')
    expect(relativeShort('2026-10-06T12:00:00Z', now)).toBe('3 d')
    expect(relativeShort('lixo', now)).toBe('—')
  })
  it('rótulo de atualização', () => {
    expect(updatedLabel(now - 20_000, now)).toBe('agora')
    expect(updatedLabel(now - 5 * 60_000, now)).toBe('há 5 min')
  })
})

describe('pct', () => {
  it('protege divisão por zero', () => {
    expect(pct(1, 0)).toBe(0)
    expect(pct(1, 3)).toBe(33)
  })
})

describe('niceAxisTop', () => {
  it('arredonda para cima em degraus legíveis', () => {
    expect(niceAxisTop(0)).toBe(4)
    expect(niceAxisTop(7)).toBe(10)
    expect(niceAxisTop(180)).toBe(200)
    expect(niceAxisTop(230)).toBe(250)
    expect(niceAxisTop(420)).toBe(500)
    expect(niceAxisTop(1000)).toBe(1000)
  })
})

describe('xLabelIndexes', () => {
  it('7 dias mostra todos; períodos longos mostram 5 marcas', () => {
    expect(xLabelIndexes(7)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(xLabelIndexes(30)).toEqual([0, 7, 15, 22, 29])
    expect(xLabelIndexes(90)).toEqual([0, 22, 45, 67, 89])
    expect(xLabelIndexes(0)).toEqual([])
  })
})

describe('dayKeyLabel', () => {
  it('formata a chave do dia local', () => {
    expect(dayKeyLabel('2026-10-08')).toBe('08 out')
  })
})
