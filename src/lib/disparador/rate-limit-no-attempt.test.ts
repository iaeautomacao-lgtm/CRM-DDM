import { describe, expect, it } from 'vitest'
import { META_ERROR_CATALOG, metaCodesWhere } from './meta-error-catalog'
import { META_RATE_LIMIT_NO_ATTEMPT_CODES, isMetaRateLimitNoAttempt } from './processQueue'
import { MetaApiError } from '@/lib/whatsapp/meta-api'

// Decisão do dono (13/10): 80007 e 4 também não consomem tentativa; a lista é DERIVADA do catálogo (sem lista duplicada).
describe('códigos de limite de taxa que não consomem tentativa', () => {
  it('é exatamente o conjunto "freio" do catálogo que não é motivo de pausa da campanha', () => {
    const derived = metaCodesWhere((e) => e.freio === true && e.pausaAutomatica !== true)
    expect([...META_RATE_LIMIT_NO_ATTEMPT_CODES].sort((a, b) => a - b)).toEqual([...derived].sort((a, b) => a - b))
    expect([...META_RATE_LIMIT_NO_ATTEMPT_CODES].sort((a, b) => a - b)).toEqual([4, 80007, 130429, 131048, 131056])
  })

  it('código de freio que também pausa a campanha NÃO entra (a pausa conta a tentativa)', () => {
    const both = META_ERROR_CATALOG.filter((e) => e.freio && e.pausaAutomatica).map((e) => e.code)
    for (const code of both) expect(META_RATE_LIMIT_NO_ATTEMPT_CODES.has(code)).toBe(false)
  })

  it('isMetaRateLimitNoAttempt reconhece os cinco e ignora outros erros', () => {
    for (const code of [130429, 131048, 131056, 80007, 4]) expect(isMetaRateLimitNoAttempt(new MetaApiError('x', code, 400))).toBe(true)
    expect(isMetaRateLimitNoAttempt(new MetaApiError('x', 131026, 400))).toBe(false)
    expect(isMetaRateLimitNoAttempt(new MetaApiError('x', 132000, 400))).toBe(false)
    expect(isMetaRateLimitNoAttempt(new Error('x'))).toBe(false)
  })
})
