import { describe, expect, it } from 'vitest'

import { COPILOT_FEEDBACK_ACTIONS, recordCopilotFeedback } from './copilot-feedback'

function fakeDb(found: { conversation_id: string }[], opts: { selectError?: boolean; insertError?: boolean } = {}) {
  const inserted: unknown[] = []
  const filters: Record<string, unknown> = {}
  const db = {
    from(table: string) {
      return {
        select: () => ({
          eq: (k: string, v: unknown) => {
            filters[k] = v
            return {
              contains: (col: string, v2: unknown) => {
                filters[col] = v2
                return { limit: async () => ({ data: found, error: opts.selectError ? { code: 'X' } : null }) }
              },
            }
          },
        }),
        insert: async (row: unknown) => {
          inserted.push({ table, row })
          return { error: opts.insertError ? { code: 'Y' } : null }
        },
      }
    },
  }
  return { db: db as never, inserted, filters }
}

describe('recordCopilotFeedback', () => {
  it('grava o evento com conta, conversa da sugestão, usuário, sugestão e ação', async () => {
    const t = fakeDb([{ conversation_id: 'conv-1' }])
    expect(await recordCopilotFeedback(t.db, { accountId: 'acc-1', userId: 'u1', suggestionId: 's1', action: 'edited' })).toEqual({ ok: true })
    expect(t.inserted).toEqual([
      { table: 'copilot_events', row: { account_id: 'acc-1', conversation_id: 'conv-1', user_id: 'u1', suggestion_id: 's1', action: 'edited' } },
    ])
    // a busca é escopada pela conta e pelo id dentro do jsonb
    expect(t.filters).toEqual({ account_id: 'acc-1', suggestions: [{ id: 's1' }] })
  })

  it('sugestão que não é da conta (ou já expirou): não grava', async () => {
    const t = fakeDb([])
    expect(await recordCopilotFeedback(t.db, { accountId: 'acc-1', userId: 'u1', suggestionId: 'zzz', action: 'used' })).toEqual({ ok: false })
    expect(t.inserted).toHaveLength(0)
  })

  it('erro de banco lança (a rota responde 500)', async () => {
    await expect(recordCopilotFeedback(fakeDb([], { selectError: true }).db, { accountId: 'a', userId: 'u', suggestionId: 's', action: 'used' })).rejects.toThrow()
    await expect(recordCopilotFeedback(fakeDb([{ conversation_id: 'c' }], { insertError: true }).db, { accountId: 'a', userId: 'u', suggestionId: 's', action: 'used' })).rejects.toThrow()
  })

  it('as ações do contrato são used, edited e ignored', () => {
    expect([...COPILOT_FEEDBACK_ACTIONS]).toEqual(['used', 'edited', 'ignored'])
  })
})
