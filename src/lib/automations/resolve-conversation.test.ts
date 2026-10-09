// resolveConversationId: o contato pode ter várias conversas de WhatsApp (o webhook abre uma nova quando a última está
// fechada). Antes era maybeSingle() e o passo de envio da automação falhava com 2+ linhas; agora vale a mais recente.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ops: [] as [string, unknown[]][],
  result: { data: [] as unknown[] | null, error: null as { message: string } | null },
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      state.ops.push(['from', [table]])
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'order', 'limit']) b[op] = (...args: unknown[]) => (state.ops.push([op, args]), b)
      b.maybeSingle = () => {
        throw new Error('não deve usar maybeSingle')
      }
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(state.result).then(ok)
      return b
    },
  }),
}))

const { resolveConversationId } = await import('./engine')

const args = (context: Record<string, unknown> = {}, contactId: string | null = 'contact-1') =>
  ({ automation: { account_id: 'acc' }, contactId, context }) as never

beforeEach(() => {
  state.ops.length = 0
  state.result = { data: [], error: null }
})

describe('resolveConversationId', () => {
  it('usa a conversa do contexto sem consultar', async () => {
    expect(await resolveConversationId(args({ conversation_id: 'ctx-conv' }))).toBe('ctx-conv')
    expect(state.ops).toEqual([])
  })

  it('várias conversas: pede a mais recente de WhatsApp da conta (order desc + limit 1)', async () => {
    state.result = { data: [{ id: 'conv-recente' }], error: null }
    expect(await resolveConversationId(args())).toBe('conv-recente')
    expect(state.ops).toEqual([
      ['from', ['conversations']],
      ['select', ['id']],
      ['eq', ['account_id', 'acc']],
      ['eq', ['contact_id', 'contact-1']],
      ['eq', ['channel_type', 'whatsapp']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [1]],
    ])
  })

  it('sem conversa, sem contato ou erro do banco: falha com mensagem clara', async () => {
    await expect(resolveConversationId(args())).rejects.toThrow('no conversation for contact')
    await expect(resolveConversationId(args({}, null))).rejects.toThrow('no contact')
    state.result = { data: null, error: { message: 'boom' } }
    await expect(resolveConversationId(args())).rejects.toThrow('conversation lookup failed: boom')
  })
})
