import { describe, expect, it } from 'vitest'
import { isBlank, likeEscape, looksLikePlaceholderName, parseContactsQuery, serializeApiContact } from './contacts'

describe('contatos da API (puro)', () => {
  it('nome que parece telefone (ou o padrao de lead da API) conta como vazio', () => {
    for (const v of ['', null, undefined, '5511988880000', '+55 (11) 98888-0000', 'API Lead']) expect(looksLikePlaceholderName(v as string | null)).toBe(true)
    for (const v of ['Ana', 'Ana 2', '12345']) expect(looksLikePlaceholderName(v)).toBe(false)
    expect(isBlank('  ')).toBe(true)
  })

  it('escapa curingas do LIKE', () => {
    expect(likeEscape('a_b%c\\d')).toBe('a\\_b\\%c\\\\d')
  })

  it('serializa sem CPF em claro', () => {
    const out = serializeApiContact({ id: '1', phone: '55', name: 'A', email: null, company: null, instituicao: 'Fac', cpf: '529.982.247-25', created_at: null, updated_at: null }, { phones: [], tags: [], customFields: {} })
    expect(out).toMatchObject({ institution: 'Fac', cpf_masked: '***.***.***-25', has_cpf: true })
    expect(JSON.stringify(out)).not.toContain('52998224725')
    expect(out).not.toHaveProperty('instituicao')
  })

  it('a busca exige filtro e limita o limit a 200', () => {
    expect(() => parseContactsQuery(new URLSearchParams('limit=5'))).toThrow()
    expect(parseContactsQuery(new URLSearchParams('tag=x&limit=999')).limit).toBe(200)
  })
})
