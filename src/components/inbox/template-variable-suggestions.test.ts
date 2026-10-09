import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))

import { variableSuggestions } from './template-picker'

describe('sugestões de variáveis do template (PRD 23 item 6)', () => {
  it('usa nome, primeiro nome, instituição e VAR1–VAR3 reais', () => {
    expect(variableSuggestions({ name: 'Maria Souza', instituicao: 'Colégio X' }, { 0: 'Maria S.', 2: 'https://x' })).toEqual([
      { label: 'Nome', value: 'Maria Souza' },
      { label: 'Primeiro nome', value: 'Maria' },
      { label: 'Instituição', value: 'Colégio X' },
      { label: 'VAR1', value: 'Maria S.' },
      { label: 'VAR3', value: 'https://x' },
    ])
  })

  it('não inventa nada sem dado (e nunca sugere CPF)', () => {
    expect(variableSuggestions(null, {})).toEqual([])
    expect(variableSuggestions({ name: '  ', instituicao: null }, { 1: ' ' })).toEqual([])
    expect(variableSuggestions({ name: 'Ana', instituicao: null }, {})).toEqual([{ label: 'Nome', value: 'Ana' }])
  })
})
