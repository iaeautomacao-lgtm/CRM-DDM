import { describe, expect, it } from 'vitest'
import { InviteBaseUrlError, resolveInviteBaseUrl } from './base-url'

const req = (headers: Record<string, string> = {}) => new Request('https://interno.local/api/account/invitations', { method: 'POST', headers })

describe('resolveInviteBaseUrl — falha fechado', () => {
  it('URL do app vence e ignora qualquer Host/X-Forwarded-Host da requisição', () => {
    const env = { NEXT_PUBLIC_APP_URL: 'https://crm.grupoddm.com.br/' }
    expect(resolveInviteBaseUrl(req({ host: 'phishing.example', 'x-forwarded-host': 'phishing.example' }), env)).toBe('https://crm.grupoddm.com.br')
  })

  it('NEXT_PUBLIC_SITE_URL ainda vale como alias legado', () => {
    expect(resolveInviteBaseUrl(req(), { NEXT_PUBLIC_SITE_URL: 'https://crm.exemplo.com' })).toBe('https://crm.exemplo.com')
  })

  it('sem URL do app: um host na lista é usado, mesmo que o cabeçalho diga outra coisa', () => {
    const env = { ALLOWED_INVITE_HOSTS: 'crm.exemplo.com' }
    expect(resolveInviteBaseUrl(req({ host: 'phishing.example' }), env)).toBe('https://crm.exemplo.com')
  })

  it('vários hosts: a requisição só escolhe entre os da lista; o link sai com o texto da lista', () => {
    const env = { ALLOWED_INVITE_HOSTS: 'crm.exemplo.com, Staging.Exemplo.com' }
    expect(resolveInviteBaseUrl(req({ 'x-forwarded-host': 'staging.exemplo.com' }), env)).toBe('https://staging.exemplo.com')
    expect(resolveInviteBaseUrl(req({ host: 'crm.exemplo.com' }), env)).toBe('https://crm.exemplo.com')
  })

  it('vários hosts e host da requisição FORA da lista: erro (nada de link para host arbitrário)', () => {
    const env = { ALLOWED_INVITE_HOSTS: 'crm.exemplo.com,staging.exemplo.com' }
    expect(() => resolveInviteBaseUrl(req({ host: 'phishing.example' }), env)).toThrow(InviteBaseUrlError)
    expect(() => resolveInviteBaseUrl(req(), env)).toThrow(/ALLOWED_INVITE_HOSTS/)
  })

  it('nada configurado: erro claro — nunca wacrm.tech nem o Host da requisição', () => {
    try {
      resolveInviteBaseUrl(req({ host: 'crm.exemplo.com' }), {})
      throw new Error('deveria lançar')
    } catch (error) {
      expect(error).toBeInstanceOf(InviteBaseUrlError)
      expect((error as Error).message).toMatch(/NEXT_PUBLIC_APP_URL/)
      expect((error as Error).message).not.toContain('wacrm.tech')
    }
  })

  it('URL do app inválida/sem http(s) não é aceita (cai na lista ou erro)', () => {
    expect(() => resolveInviteBaseUrl(req(), { NEXT_PUBLIC_APP_URL: 'javascript:alert(1)' })).toThrow(InviteBaseUrlError)
    expect(() => resolveInviteBaseUrl(req(), { NEXT_PUBLIC_APP_URL: 'não é url' })).toThrow(InviteBaseUrlError)
  })

  it('localhost na lista usa http (desenvolvimento)', () => {
    expect(resolveInviteBaseUrl(req(), { ALLOWED_INVITE_HOSTS: 'localhost:3000' })).toBe('http://localhost:3000')
  })
})
