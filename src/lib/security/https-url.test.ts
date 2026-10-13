import { describe, expect, it } from 'vitest'
import { isHttpsOrAllowlistedUrl } from './ssrf-guard'

describe('isHttpsOrAllowlistedUrl (waha_url e VOIP_URL)', () => {
  const noAllow = {} as NodeJS.ProcessEnv

  it('https sempre vale', () => {
    expect(isHttpsOrAllowlistedUrl('https://waha.exemplo.com.br', noAllow)).toBe(true)
    expect(isHttpsOrAllowlistedUrl('https://waha.exemplo.com.br:3000/api', noAllow)).toBe(true)
  })

  it('http só para host em SSRF_ALLOWED_HOSTS (exato ou *.dominio)', () => {
    const env = { SSRF_ALLOWED_HOSTS: 'voip.internal, *.rede.local' } as unknown as NodeJS.ProcessEnv
    expect(isHttpsOrAllowlistedUrl('http://voip.internal:8080', env)).toBe(true)
    expect(isHttpsOrAllowlistedUrl('http://waha.rede.local', env)).toBe(true)
    expect(isHttpsOrAllowlistedUrl('http://outro.exemplo.com', env)).toBe(false)
    expect(isHttpsOrAllowlistedUrl('http://voip.internal', noAllow)).toBe(false)
  })

  it('recusa esquema estranho e URL inválida', () => {
    const env = { SSRF_ALLOWED_HOSTS: 'voip.internal' } as unknown as NodeJS.ProcessEnv
    expect(isHttpsOrAllowlistedUrl('ftp://voip.internal', env)).toBe(false)
    expect(isHttpsOrAllowlistedUrl('javascript:alert(1)', env)).toBe(false)
    expect(isHttpsOrAllowlistedUrl('voip.internal:8080', env)).toBe(false)
    expect(isHttpsOrAllowlistedUrl('', env)).toBe(false)
  })
})
