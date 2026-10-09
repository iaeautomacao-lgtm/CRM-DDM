import { describe, expect, it } from 'vitest'

import { enteredWaiting, isWaitingConversation } from './waiting-alert'

const conv = (status: 'open' | 'pending' | 'closed', assigned?: string) => ({ status, assigned_agent_id: assigned })

describe('aviso de conversa em espera (PRD 23 item 14)', () => {
  it('espera = ativa e sem atendente', () => {
    expect(isWaitingConversation(conv('pending'))).toBe(true)
    expect(isWaitingConversation(conv('open'))).toBe(true)
    expect(isWaitingConversation(conv('open', 'u1'))).toBe(false)
    expect(isWaitingConversation(conv('closed'))).toBe(false)
  })

  it('conversa nova sem atendente avisa; com atendente ou encerrada não', () => {
    expect(enteredWaiting(null, conv('pending'), true)).toBe(true)
    expect(enteredWaiting(null, conv('open', 'u1'), true)).toBe(false)
    expect(enteredWaiting(null, conv('closed'), true)).toBe(false)
  })

  it('voltou para a fila avisa; já esperando ou desconhecida não', () => {
    expect(enteredWaiting(conv('open', 'u1'), conv('open'), false)).toBe(true)
    expect(enteredWaiting(conv('closed'), conv('pending'), false)).toBe(true)
    expect(enteredWaiting(conv('pending'), conv('pending'), false)).toBe(false)
    expect(enteredWaiting(undefined, conv('pending'), false)).toBe(false)
  })
})
