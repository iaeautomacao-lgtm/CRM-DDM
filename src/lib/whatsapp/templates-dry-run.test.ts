import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTemplatesDryRunWarning, templatesDryRunEnabled } from './templates-dry-run'

describe('WHATSAPP_TEMPLATES_DRY_RUN (ENV-05)', () => {
  const warn = vi.fn()
  beforeEach(() => {
    warn.mockClear()
    resetTemplatesDryRunWarning()
  })

  it('em desenvolvimento/teste continua funcionando', () => {
    expect(templatesDryRunEnabled({ WHATSAPP_TEMPLATES_DRY_RUN: 'true', NODE_ENV: 'development' }, { warn })).toBe(true)
    expect(templatesDryRunEnabled({ WHATSAPP_TEMPLATES_DRY_RUN: '1', NODE_ENV: 'test' }, { warn })).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('em PRODUÇÃO é ignorada (não gera template sintético) e avisa uma vez só', () => {
    const env = { WHATSAPP_TEMPLATES_DRY_RUN: 'true', NODE_ENV: 'production' }
    expect(templatesDryRunEnabled(env, { warn })).toBe(false)
    expect(templatesDryRunEnabled({ ...env, WHATSAPP_TEMPLATES_DRY_RUN: '1' }, { warn })).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('ignorada em produção')
  })

  it('desligada por padrão (e sem aviso em produção sem a variável)', () => {
    expect(templatesDryRunEnabled({ NODE_ENV: 'production' }, { warn })).toBe(false)
    expect(templatesDryRunEnabled({ WHATSAPP_TEMPLATES_DRY_RUN: 'false', NODE_ENV: 'development' }, { warn })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})
