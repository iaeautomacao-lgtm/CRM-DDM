import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/flows/engine', () => ({ endActiveRunForConversation: vi.fn() }))

import { BATCH_MAX_ITEMS, mapLimited, parseBatchIds, summarizeBatch } from './batch'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('parseBatchIds', () => {
  it('aceita UUIDs e remove duplicados', () => {
    expect(parseBatchIds([A, B, A])).toEqual({ ok: true, ids: [A, B] })
  })
  it('rejeita vazio, não-lista e ids inválidos', () => {
    expect(parseBatchIds([])).toMatchObject({ ok: false, status: 400 })
    expect(parseBatchIds('x')).toMatchObject({ ok: false, status: 400 })
    expect(parseBatchIds([A, 'abc'])).toMatchObject({ ok: false, status: 400 })
  })
  it('rejeita acima do limite com 413', () => {
    const many = Array.from({ length: BATCH_MAX_ITEMS + 1 }, () => A)
    expect(parseBatchIds(many)).toMatchObject({ ok: false, status: 413 })
  })
})

describe('summarizeBatch / mapLimited', () => {
  it('conta ok e falhas', () => {
    expect(
      summarizeBatch([
        { conversation_id: A, ok: true },
        { conversation_id: B, ok: false, code: 'not_found' },
      ]),
    ).toEqual({ total: 2, ok: 1, failed: 1 })
  })
  it('mantém a ordem da entrada', async () => {
    const out = await mapLimited([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20])
  })
})
