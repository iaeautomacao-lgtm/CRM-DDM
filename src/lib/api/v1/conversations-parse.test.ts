import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api/v1/respond'
import { parseCloseBody, parseOpenBody, parseTransferBody } from './conversations-parse'

const U = '00000000-0000-4000-8000-000000000001'
const fails = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(400)
    return
  }
  throw new Error('deveria falhar')
}

describe('parseTransferBody', () => {
  it('aceita agente e/ou equipe; null remove; confirm_paused e reason', () => {
    expect(parseTransferBody({ assignee_id: U })).toMatchObject({ assigneeId: U, teamId: undefined, confirmPaused: false })
    expect(parseTransferBody({ assignee_id: null, team_id: U, confirm_paused: true, reason: ' ok ' })).toEqual({ assigneeId: null, teamId: U, confirmPaused: true, reason: 'ok' })
  })
  it('recusa corpo vazio, ids ruins, campo desconhecido e confirm não booleano', () => {
    for (const b of [null, [], {}, { assignee_id: 'x' }, { assignee_id: U, foo: 1 }, { assignee_id: U, confirm_paused: 'sim' }, { assignee_id: U, reason: 'x'.repeat(501) }]) fails(() => parseTransferBody(b))
  })
})

describe('parseCloseBody', () => {
  it('código ou id (um só); nota opcional', () => {
    expect(parseCloseBody({ tabulation_code: 142, note: ' Acordo ' })).toEqual({ tabulationId: null, tabulationCode: 142, note: 'Acordo' })
    expect(parseCloseBody({ tabulation_id: U })).toEqual({ tabulationId: U, tabulationCode: null, note: undefined })
  })
  it('recusa sem tabulação, as duas, código não inteiro, nota longa', () => {
    for (const b of [{}, { tabulation_code: 1, tabulation_id: U }, { tabulation_code: '1' }, { tabulation_code: 1.5 }, { tabulation_code: -1 }, { tabulation_code: 1, note: 'x'.repeat(1001) }, { tabulation_code: 1, extra: 1 }]) fails(() => parseCloseBody(b))
  })
})

describe('parseOpenBody', () => {
  it('telefone ou contato; atendente/equipe; canal; mensagem texto ou template', () => {
    const t = parseOpenBody({ to: ' +5527999991212 ', assignee_id: U, channel: '+55 27 99999-1212', message: { template: { name: 'lembrete', variables: ['a', 2] } } })
    expect(t).toMatchObject({ phone: '+5527999991212', assigneeId: U, teamId: null, channel: '+55 27 99999-1212', message: { kind: 'template', name: 'lembrete', language: 'pt_BR', variables: ['a', '2'] } })
    expect(parseOpenBody({ contact_id: U, team_id: U, force_transfer: true, message: { text: 'oi' } })).toMatchObject({ contactId: U, phone: null, teamId: U, forceTransfer: true, message: { kind: 'text', text: 'oi' } })
    expect(parseOpenBody({ phone: '+5527999991212' })).toMatchObject({ message: null, assigneeId: null, teamId: null, channel: null })
  })
  it('recusa: sem alvo, os dois alvos, null em atendente/equipe, mensagem ambígua ou inválida, campo desconhecido', () => {
    const base = { phone: '+5527999991212' }
    for (const b of [
      {}, { ...base, contact_id: U }, { ...base, assignee_id: null }, { ...base, team_id: null }, { ...base, foo: 1 }, { ...base, channel: 'a b!' },
      { ...base, message: {} }, { ...base, message: { text: 'a', template: { name: 'x' } } }, { ...base, message: { text: '  ' } }, { ...base, message: { template: { name: 'Nome Ruim' } } },
      { ...base, message: { template: { name: 'ok', variables: [''] } } }, { ...base, message: { template: { name: 'ok', variables: 'a' } } },
    ]) fails(() => parseOpenBody(b))
  })
})
