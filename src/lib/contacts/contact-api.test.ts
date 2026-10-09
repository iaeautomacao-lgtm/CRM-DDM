import { describe, expect, it } from 'vitest'
import { parseCpf, parseEmail, parseName, parsePhone, serializeContact } from './contact-api'

describe('parsePhone', () => {
  it('normaliza para só dígitos (DDI+DDD+número) e recusa o resto', () => {
    expect(parsePhone('+55 (11) 99999-0001')).toEqual({ ok: true, value: '5511999990001' })
    expect(parsePhone(5511999990001)).toEqual({ ok: true, value: '5511999990001' })
    for (const bad of ['', '123', 'abc', '0011999990001', null, undefined, {}]) expect(parsePhone(bad).ok).toBe(false)
  })
})

describe('parseCpf', () => {
  it('aceita máscara e guarda só dígitos; vazio/null limpa', () => {
    expect(parseCpf('529.982.247-25')).toEqual({ ok: true, value: '52998224725' })
    expect(parseCpf('')).toEqual({ ok: true, value: null })
    expect(parseCpf(null)).toEqual({ ok: true, value: null })
  })
  it('recusa dígito verificador errado, sequência repetida e tipo errado', () => {
    for (const bad of ['529.982.247-24', '111.111.111-11', '123', {}, true]) expect(parseCpf(bad).ok).toBe(false)
  })
})

describe('parseEmail / parseName', () => {
  it('e-mail: minúsculo, vazio limpa, inválido recusa', () => {
    expect(parseEmail(' Fulano@Ex.com ')).toEqual({ ok: true, value: 'fulano@ex.com' })
    expect(parseEmail('')).toEqual({ ok: true, value: null })
    expect(parseEmail('sem-arroba').ok).toBe(false)
  })
  it('nome: apara, vazio = null, teto de tamanho', () => {
    expect(parseName('  Maria  ')).toEqual({ ok: true, value: 'Maria' })
    expect(parseName('   ')).toEqual({ ok: true, value: null })
    expect(parseName('x'.repeat(201)).ok).toBe(false)
    expect(parseName(5).ok).toBe(false)
  })
})

describe('serializeContact', () => {
  it('o CPF nunca sai em claro', () => {
    const out = serializeContact({ id: 'c1', name: 'Fulano', cpf: '52998224725' })
    expect(out).toEqual({ id: 'c1', name: 'Fulano', cpf_masked: '***.***.***-25', has_cpf: true })
    expect(JSON.stringify(out)).not.toContain('52998224725')
    expect(serializeContact({ id: 'c2', cpf: null })).toEqual({ id: 'c2', cpf_masked: null, has_cpf: false })
  })
})
