import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ rpc }) }))
const writeLog = vi.fn()
vi.mock('@/lib/logger', () => ({ writeLog: (...a: unknown[]) => writeLog(...a) }))

import { hasMentionReservation, tryMentionAgentHandoff } from './agent-mention-server'

const A = 'acc-1'
const C = 'conv-1'

beforeEach(() => {
  rpc.mockReset()
  writeLog.mockReset()
})

describe('tryMentionAgentHandoff', () => {
  it('mensagem sem menção no início: não chama a RPC', async () => {
    expect(await tryMentionAgentHandoff({ accountId: A, conversationId: C, text: 'oi, @adriana' })).toBe(false)
    expect(await tryMentionAgentHandoff({ accountId: A, conversationId: C, text: null })).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('menção válida e roteada: true, com o alias normalizado e log só com ids', async () => {
    rpc.mockResolvedValue({ data: 'agent-9', error: null })
    expect(await tryMentionAgentHandoff({ accountId: A, conversationId: C, text: '@Adriana preciso de ajuda, meu CPF 123' })).toBe(true)
    expect(rpc).toHaveBeenCalledWith('route_conversation_to_mentioned_agent', { p_account_id: A, p_conversation_id: C, p_alias: 'adriana' })
    const log = writeLog.mock.calls[0][0] as { payload: Record<string, unknown>; message: string }
    expect(Object.keys(log.payload).sort()).toEqual(['agent_id', 'conversation_id'])
    expect(JSON.stringify(log)).not.toMatch(/CPF|preciso/)
  })

  it('alias sem operador (RPC devolve null): false, segue o fluxo normal', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await tryMentionAgentHandoff({ accountId: A, conversationId: C, text: '@ninguem oi' })).toBe(false)
    expect(writeLog).not.toHaveBeenCalled()
  })

  it('migration 376 ainda não aplicada (função inexistente): false, sem derrubar o webhook', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'function does not exist' } })
    expect(await tryMentionAgentHandoff({ accountId: A, conversationId: C, text: '@adriana oi' })).toBe(false)
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } })
    expect(await tryMentionAgentHandoff({ accountId: A, conversationId: C, text: '@adriana oi' })).toBe(false)
  })

  it('outro erro da RPC: falha fechada (lança), sem cair na IA', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } })
    await expect(tryMentionAgentHandoff({ accountId: A, conversationId: C, text: '@adriana oi' })).rejects.toBeTruthy()
    spy.mockRestore()
  })
})

describe('hasMentionReservation', () => {
  const dbWith = (result: { data: unknown; error: unknown } | Error) => ({
    from: () => ({
      select: () => ({
        eq: () => ({ limit: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }),
      }),
    }),
  })

  it('true só quando requested_agent_id está preenchido', async () => {
    expect(await hasMentionReservation(dbWith({ data: [{ requested_agent_id: 'agent-1' }], error: null }), C)).toBe(true)
    expect(await hasMentionReservation(dbWith({ data: [{ requested_agent_id: null }], error: null }), C)).toBe(false)
    expect(await hasMentionReservation(dbWith({ data: [], error: null }), C)).toBe(false)
  })

  it('falha aberta: coluna inexistente, erro de leitura ou exceção = sem reserva', async () => {
    expect(await hasMentionReservation(dbWith({ data: null, error: { code: '42703' } }), C)).toBe(false)
    expect(await hasMentionReservation(dbWith(new Error('rede')), C)).toBe(false)
    expect(await hasMentionReservation(dbWith({ data: [], error: null }), null)).toBe(false)
  })
})
