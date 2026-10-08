import { describe, expect, it } from 'vitest'
import { contactForMessage } from './webhook-contacts'
import { extractMessageEvents } from './message-inbox'

// WH-04 (PRD 15): contato da mensagem por wa_id == from, nunca por índice.

const A = { profile: { name: 'Cliente A' }, wa_id: '5511999990001' }
const B = { profile: { name: 'Cliente B' }, wa_id: '5511999990002' }

describe('contactForMessage', () => {
  it('casa por wa_id independentemente da ordem e do tamanho das listas', () => {
    expect(contactForMessage([B, A], '5511999990001')).toBe(A)
    expect(contactForMessage([B, A], '5511999990002')).toBe(B)
  })

  it('ignora formatação (+, espaços, traços) no from e no wa_id', () => {
    expect(contactForMessage([{ ...A, wa_id: '+55 (11) 99999-0001' }], '5511999990001')).toBeTruthy()
  })

  it('tolera diferença de prefixo/9º dígito pela regra de sufixo (últimos 8)', () => {
    const semNove = { profile: { name: 'X' }, wa_id: '551199990001' }
    expect(contactForMessage([semNove], '5511999990001')).toBe(semNove)
  })

  it('sem correspondência devolve null — NUNCA o contato de outro remetente', () => {
    expect(contactForMessage([A], '5521988880000')).toBeNull()
    expect(contactForMessage([], '5511999990001')).toBeNull()
    expect(contactForMessage(undefined, '5511999990001')).toBeNull()
    expect(contactForMessage([A], '')).toBeNull()
  })

  it('tolera entradas sem wa_id/profile', () => {
    expect(contactForMessage([{}, { wa_id: null }, A], '5511999990001')).toBe(A)
  })
})

describe('extractMessageEvents (inbox) usa o contato por wa_id', () => {
  const channels = new Map([['phone:PN1', { id: 'CH1', account_id: 'ACC1' }]])
  const key = () => 'phone:PN1'

  it('duas mensagens de remetentes diferentes, contatos em ordem invertida e faltando um', () => {
    const body = {
      entry: [
        {
          id: 'W',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PN1' },
                contacts: [B],
                messages: [
                  { id: 'wamid.A', from: '5511999990001', timestamp: '1760000000' },
                  { id: 'wamid.B', from: '5511999990002', timestamp: '1760000001' },
                ],
              },
            },
          ],
        },
      ],
    }
    const events = extractMessageEvents(body, channels, key)
    expect(events).toHaveLength(2)
    // A não ganha o nome de B (antes: contacts[0] valia para todos os sem par por índice)
    expect(events[0].payload.contact).toBeNull()
    expect(events[1].payload.contact).toBe(B)
  })
})
