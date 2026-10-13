import { beforeEach, describe, expect, it, vi } from 'vitest'

// Migration 335: telefone PRINCIPAL recusado como inválido é lembrado no contato (phone_invalid_at/phone_invalid_normalized).
const state = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; values: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  markError: null as null | { code?: string; message: string },
  send: vi.fn(),
}))

vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: vi.fn(async (name: string) => ({ data: name === 'claim_dispatch_item' ? true : null, error: null })),
    from: (table: string) => {
      const filters: Array<[string, unknown]> = []
      let values: Record<string, unknown> | null = null
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'order', 'limit', 'lte', 'is', 'or']) b[m] = () => b
      b.eq = (c: string, v: unknown) => (filters.push([c, v]), b)
      b.update = (v: Record<string, unknown>) => ((values = v), state.updates.push({ table, values: v, filters }), b)
      b.maybeSingle = async () => ({ data: table === 'contacts' ? { phone_normalized: '5511999998888' } : table === 'contact_phones' ? { phone: '5511977776666' } : table === 'whatsapp_config' ? { provider: 'meta', access_token: 'x', phone_number_id: 'p' } : null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === 'disp_message_queue' ? [{ id: 'i1' }] : null, error: values && table === 'contacts' ? state.markError : null }).then(resolve)
      return b
    },
  }),
}))
vi.mock('@/lib/logger', () => ({ writeLog: vi.fn(), maskPhone: () => 'masked' }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decryptStoredSecret: () => 'token' }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()), sendTextMessage: state.send }))

import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { processQueueItem, type QueueItem } from './processQueue'

const item: QueueItem = { id: 'i1', campaign_id: 'c1', contact_id: 'ct1', session_id: 'ch', tipo: 'texto', mensagem_final: 'oi', contacts: { phone: '5511999998888' } }
const run = (over: Partial<QueueItem> = {}) => processQueueItem({ ...item, ...over }, { id: 'c1', status: 'em_execucao' }, { channelConfig: { provider: 'meta', access_token: 'x', phone_number_id: 'p' }, blacklistLookup: () => false, alreadyClaimed: true })
const flush = () => new Promise((r) => setTimeout(r, 0))
const marks = () => state.updates.filter((u) => u.table === 'contacts')

beforeEach(() => {
  state.updates.length = 0
  state.markError = null
  state.send.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('lembrar o telefone principal inválido', () => {
  it.each([131021, 131045, 131030])('Meta %s no telefone PRINCIPAL grava a marca com o normalizado recusado', async (code) => {
    state.send.mockRejectedValue(new MetaApiError('número inválido', code, 400))
    await run()
    await flush()
    expect(marks()).toHaveLength(1)
    expect(marks()[0].values).toMatchObject({ phone_invalid_normalized: '5511999998888' })
    expect(typeof marks()[0].values.phone_invalid_at).toBe('string')
    // só marca se o telefone do contato ainda for esse (não sobrescreve um telefone trocado no meio)
    expect(marks()[0].filters).toContainEqual(['phone_normalized', '5511999998888'])
  })

  it('erro que NÃO é de número inválido (ex.: janela de 24h, limite de taxa) não marca', async () => {
    state.send.mockRejectedValue(new MetaApiError('fora da janela', 131047, 400))
    await run()
    await flush()
    expect(marks()).toHaveLength(0)
    state.send.mockRejectedValue(new MetaApiError('limite', 130429, 429))
    await run()
    await flush()
    expect(marks()).toHaveLength(0)
  })

  it('telefone alternativo (ordem > 1) segue marcando contact_phones, não o contato', async () => {
    state.send.mockRejectedValue(new MetaApiError('número inválido', 131021, 400))
    await run({ phone_attempt_order: 2 })
    await flush()
    expect(marks()).toHaveLength(0)
    expect(state.updates.some((u) => u.table === 'contact_phones' && u.values.status === 'invalido')).toBe(true)
  })

  it('migration 335 ausente (coluna inexistente): ignora em silêncio e o fluxo do envio não muda', async () => {
    state.markError = { code: '42703', message: 'column contacts.phone_invalid_at does not exist' }
    state.send.mockRejectedValue(new MetaApiError('número inválido', 131021, 400))
    const result = await run()
    await flush()
    // O resultado é o de sempre para número inválido (escada de telefones ou erro): a marca ausente não o altera.
    expect(['error', 'deferred']).toContain(result.outcome)
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('markPhoneInvalid: falha ao marcar o contato'), expect.anything())
  })
})
