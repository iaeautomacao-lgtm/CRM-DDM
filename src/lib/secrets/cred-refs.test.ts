import { describe, expect, it } from 'vitest'
import { extractCredRefs, missingCredNames, toolHttpTexts } from './cred-refs'

describe('extractCredRefs', () => {
  it('acha nomes em vários textos, sem repetir', () => {
    expect(extractCredRefs(['Bearer {{cred.DDM_TOKEN}}', '{{ cred.OUTRA }}', '{{cred.DDM_TOKEN}}', null])).toEqual([
      'DDM_TOKEN',
      'OUTRA',
    ])
  })
  it('ignora variáveis e parâmetros', () => {
    expect(extractCredRefs(['{{var.X}} {{cpf}}'])).toEqual([])
  })
})

describe('missingCredNames', () => {
  it('só considera credenciais, não variáveis', () => {
    const secrets = [
      { name: 'A', kind: 'credential' as const },
      { name: 'B', kind: 'variable' as const },
    ]
    expect(missingCredNames(['A', 'B', 'C'], secrets)).toEqual(['B', 'C'])
  })
})

describe('toolHttpTexts', () => {
  it('junta url, headers e body', () => {
    expect(toolHttpTexts({ url: 'u', headers: { h: 'v' }, body: 'b' })).toEqual(['u', 'v', 'b'])
  })
})
