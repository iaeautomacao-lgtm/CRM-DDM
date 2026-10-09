// loadSendLine: a automação envia pela linha da conversa. Antes, whatsapp_config.eq(account_id).single() falhava em toda
// conta com 2+ linhas ("WhatsApp not configured for this account").
import { describe, expect, it, vi } from 'vitest'

vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({}) }))
const { loadSendLine } = await import('./meta-send')

type Res = { data: unknown; error: { message: string } | null }
function fakeDb(conv: Res, lines: Res) {
  const ops: Record<string, [string, unknown[]][]> = { conversations: [], whatsapp_config: [] }
  const db = {
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'limit']) b[op] = (...a: unknown[]) => (ops[table].push([op, a]), b)
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(table === 'conversations' ? conv : lines).then(ok)
      return b
    },
  }
  return { db: db as never, ops }
}
const ok = (data: unknown): Res => ({ data, error: null })

describe('loadSendLine', () => {
  it('conversa com config_id: usa essa linha (escopo da conta)', async () => {
    const f = fakeDb(ok([{ config_id: 'L2' }]), ok([{ id: 'L2', phone_number_id: 'p2' }]))
    expect(await loadSendLine(f.db, 'acc', 'conv')).toEqual({ id: 'L2', phone_number_id: 'p2' })
    expect(f.ops.conversations).toContainEqual(['eq', ['account_id', 'acc']])
    expect(f.ops.whatsapp_config).toEqual([
      ['select', ['*']],
      ['eq', ['account_id', 'acc']],
      ['eq', ['id', 'L2']],
      ['limit', [2]],
    ])
  })

  it('conversa antiga sem config_id: a única linha Meta da conta', async () => {
    const f = fakeDb(ok([{ config_id: null }]), ok([{ id: 'L1' }]))
    expect(await loadSendLine(f.db, 'acc', 'conv')).toEqual({ id: 'L1' })
    expect(f.ops.whatsapp_config).toContainEqual(['eq', ['provider', 'meta']])
  })

  it('sem config_id e várias linhas Meta: não adivinha', async () => {
    const f = fakeDb(ok([{ config_id: null }]), ok([{ id: 'L1' }, { id: 'L2' }]))
    await expect(loadSendLine(f.db, 'acc', 'conv')).rejects.toThrow(/several Meta lines/)
  })

  it('sem linha ou erro de leitura', async () => {
    await expect(loadSendLine(fakeDb(ok([]), ok([])).db, 'acc', 'conv')).rejects.toThrow('WhatsApp not configured for this account')
    await expect(loadSendLine(fakeDb({ data: null, error: { message: 'x' } }, ok([])).db, 'acc', 'c')).rejects.toThrow(/conversation lookup failed/)
    await expect(loadSendLine(fakeDb(ok([]), { data: null, error: { message: 'y' } }).db, 'acc', 'c')).rejects.toThrow(/whatsapp_config lookup failed/)
  })
})
