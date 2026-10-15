import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api/v1/respond'
import { apiTemplateProblem, checkVariableCount, normalizeCategory, parseSendTemplateBody, parseTemplatesQuery } from './templates'

const row = (over: Record<string, unknown> = {}) => ({ name: 'n', language: 'pt_BR', status: 'APPROVED', body_text: 'Oi {{1}}', header_type: null, header_content: null, buttons: null, ...over })
const fails = (fn: () => unknown, status = 400) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(status)
    return
  }
  throw new Error('deveria falhar')
}

describe('templates da API', () => {
  it('normaliza categoria do banco para maiúsculas', () => {
    expect(normalizeCategory('Marketing')).toBe('MARKETING')
    expect(normalizeCategory('utility')).toBe('UTILITY')
    expect(normalizeCategory('Authentication')).toBe('AUTHENTICATION')
    expect(normalizeCategory('x')).toBeNull()
  })

  it('apiTemplateProblem: aprovado e simples = null; os demais dizem o motivo', () => {
    expect(apiTemplateProblem(row())).toBeNull()
    expect(apiTemplateProblem(row({ status: 'approved' }))).toBeNull()
    expect(apiTemplateProblem(row({ status: 'REJECTED' }))).toMatch(/REJECTED/)
    expect(apiTemplateProblem(row({ header_type: 'video' }))).toMatch(/mídia/)
    expect(apiTemplateProblem(row({ header_type: 'text', header_content: 'Oi {{1}}' }))).toMatch(/cabeçalho/)
    expect(apiTemplateProblem(row({ header_type: 'text', header_content: 'Oi' }))).toBeNull()
    expect(apiTemplateProblem(row({ buttons: [{ type: 'URL', url: 'https://x.com' }] }))).toBeNull()
    expect(apiTemplateProblem(row({ buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] }))).toMatch(/link dinâmico/)
    expect(apiTemplateProblem(row({ buttons: [{ type: 'copy_code' }] }))).toMatch(/copiar código/)
    expect(apiTemplateProblem(row({ buttons: [{ type: 'FLOW' }] }))).toMatch(/Flow/)
  })

  it('checkVariableCount compara com o maior {{n}} do corpo', () => {
    expect(() => checkVariableCount({ name: 'n', body_text: 'Oi {{1}} {{2}}' }, ['a', 'b'])).not.toThrow()
    fails(() => checkVariableCount({ name: 'n', body_text: 'Oi {{1}} {{2}}' }, ['a']))
    expect(() => checkVariableCount({ name: 'n', body_text: 'Sem variável' }, [])).not.toThrow()
  })

  it('parseSendTemplateBody: defaults, números viram texto, validações', () => {
    const ok = parseSendTemplateBody({ phone: '+5527999991212', template: { name: 'x_1' }, variables: ['a', 2] })
    expect(ok).toMatchObject({ phone: '+5527999991212', templateName: 'x_1', language: 'pt_BR', variables: ['a', '2'], channel: null, salvarBd: true })
    expect(parseSendTemplateBody({ to: '1', template: { name: 'x', language: 'en_US' }, salvar_bd: false }).salvarBd).toBe(false)
    fails(() => parseSendTemplateBody({ template: { name: 'x' } }))
    fails(() => parseSendTemplateBody({ to: '1' }))
    fails(() => parseSendTemplateBody({ to: '1', template: { name: 'Nome Inválido' } }))
    fails(() => parseSendTemplateBody({ to: '1', template: { name: 'x', language: 'português' } }))
    fails(() => parseSendTemplateBody({ to: '1', template: { name: 'x' }, variables: ['a', ''] }))
    fails(() => parseSendTemplateBody({ to: '1', template: { name: 'x' }, variables: [{}] }))
    fails(() => parseSendTemplateBody({ to: '1', template: { name: 'x' }, channel: '; drop' }))
  })

  it('parseTemplatesQuery: padrões e rejeições', () => {
    const q = parseTemplatesQuery(new URLSearchParams())
    expect(q).toMatchObject({ status: 'APPROVED', limit: 50, cursor: null, namePrefix: null })
    expect(parseTemplatesQuery(new URLSearchParams('status=all')).status).toBeNull()
    expect(parseTemplatesQuery(new URLSearchParams('status=pending&limit=500')).limit).toBe(200)
    fails(() => parseTemplatesQuery(new URLSearchParams('status=foo')))
    fails(() => parseTemplatesQuery(new URLSearchParams('language=pt-BR!')))
    fails(() => parseTemplatesQuery(new URLSearchParams('channel=abc')))
  })
})
