import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/storage/chat-media', () => ({
  chatMediaPath: (url: string) => (url.startsWith('/api/chat-media/') ? decodeURIComponent(url.slice('/api/chat-media/'.length)) : null),
}))

import {
  authorTypeOf, decodeCursor, encodeCursor, loadConversationPage, loadMessagePage, mediaDescriptor, parseConversationFilters, parseIso, parseLimit,
  phoneCandidates, toApiMessage, type MessageRow,
} from './extract'

const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1', conversation_id: 'c1', seq: '1', created_at: '2026-10-08T14:03:22.114112+00:00', sender_type: 'customer', sender_id: null, origin: 'customer',
  content_type: 'text', content_text: 'oi', media_url: null, template_name: null, status: 'sent', reply_to_message_id: null, campaign_id: null, contact_id: 'ct1', ...over,
})
const lookups = { agents: new Map([['u1', 'Ana']]), contacts: new Map([['ct1', 'Carlos']]), signedUrls: new Map<string, string>() }

describe('autor por origem', () => {
  it.each(['customer', 'operator', 'ai', 'flow', 'campaign', 'automation', 'api'] as const)('origin %s vira author.type %s', (origin) => {
    expect(authorTypeOf({ origin, sender_type: 'agent', sender_id: 'u1' })).toBe(origin)
  })
  it('origin NULL (histórico antigo) vira automation, exceto cliente e atendente identificado', () => {
    expect(authorTypeOf({ origin: null, sender_type: 'bot', sender_id: null })).toBe('automation')
    expect(authorTypeOf({ origin: null, sender_type: 'agent', sender_id: null })).toBe('automation')
    expect(authorTypeOf({ origin: null, sender_type: 'customer', sender_id: null })).toBe('customer')
    expect(authorTypeOf({ origin: null, sender_type: 'agent', sender_id: 'u1' })).toBe('operator')
  })
  it('operador traz id e nome; cliente traz o contato; IA e demais não trazem pessoa', () => {
    expect(toApiMessage(msg({ origin: 'operator', sender_type: 'agent', sender_id: 'u1' }), lookups).author).toEqual({ type: 'operator', id: 'u1', name: 'Ana' })
    expect(toApiMessage(msg(), lookups).author).toEqual({ type: 'customer', id: 'ct1', name: 'Carlos' })
    expect(toApiMessage(msg({ origin: 'ai', sender_type: 'bot' }), lookups).author).toEqual({ type: 'ai', id: null, name: null })
    expect(toApiMessage(msg({ origin: 'campaign', sender_type: 'agent', sender_id: null }), lookups).author).toEqual({ type: 'campaign', id: null, name: null })
  })
})

describe('mensagem', () => {
  it('direção, horário ISO UTC, seq numérico, template e campanha', () => {
    const m = toApiMessage(msg({ sender_type: 'agent', origin: 'campaign', seq: '7', template_name: 'cobranca', campaign_id: 'k1', content_type: 'template', status: 'delivered' }), lookups)
    expect(m).toMatchObject({ direction: 'outbound', seq: 7, created_at: '2026-10-08T14:03:22.114Z', template: { name: 'cobranca', variables: null }, campaign_id: 'k1', status: 'delivered' })
    expect(toApiMessage(msg(), lookups).direction).toBe('inbound')
  })
  it('mídia SEM URL por padrão; com URL assinada só quando fornecida; mime e nome vêm do caminho', () => {
    const row = msg({ content_type: 'audio', media_url: '/api/chat-media/account-1/abc%20123.ogg' })
    const plain = toApiMessage(row, lookups)
    expect(plain.media).toEqual({ type: 'audio', mime: 'audio/ogg', filename: 'abc 123.ogg', size: null })
    expect(JSON.stringify(plain)).not.toContain('/api/chat-media')
    const signed = toApiMessage(row, { ...lookups, signedUrls: new Map([[row.media_url!, 'https://storage/assinada?token=x']]) })
    expect(signed.media?.url).toBe('https://storage/assinada?token=x')
    expect(mediaDescriptor({ media_url: null, content_type: 'text' })).toBeNull()
  })
})

describe('parâmetros', () => {
  it('limit: padrão, teto e inválido', () => {
    expect(parseLimit(null, 100, 500)).toBe(100)
    expect(parseLimit('9999', 100, 500)).toBe(500)
    expect(() => parseLimit('0', 100, 500)).toThrow()
    expect(() => parseLimit('x', 100, 500)).toThrow()
  })
  it('cursor ida e volta; lixo = 400', () => {
    expect(decodeCursor(encodeCursor(['a', 'b']), 2)).toEqual(['a', 'b'])
    expect(decodeCursor(null, 2)).toBeNull()
    expect(() => decodeCursor('!!', 2)).toThrow()
    expect(() => decodeCursor(encodeCursor(['a']), 2)).toThrow()
  })
  it('datas ISO e filtros de conversa', () => {
    expect(parseIso('2026-10-01', 'from')).toBe('2026-10-01T00:00:00.000Z')
    expect(() => parseIso('ontem', 'from')).toThrow()
    expect(parseConversationFilters(new URLSearchParams('status=closed&channel=webchat&phone=(11) 99999-8888'))).toMatchObject({ status: 'closed', channel: 'webchat', phone: '11999998888' })
    expect(() => parseConversationFilters(new URLSearchParams('status=xyz'))).toThrow()
    expect(() => parseConversationFilters(new URLSearchParams('team_id=nao-uuid'))).toThrow()
    expect(() => parseConversationFilters(new URLSearchParams('updated_from=2026-10-09&updated_to=2026-10-01'))).toThrow()
    expect(phoneCandidates('11999998888')).toEqual(['11999998888', '5511999998888'])
    expect(phoneCandidates('5511999998888')).toEqual(['5511999998888', '11999998888'])
  })
})

describe('loadMessagePage', () => {
  const rowsFor = (n: number) => Array.from({ length: n }, (_, i) => msg({ id: `m${i + 1}`, seq: i + 1, created_at: `2026-10-08T14:0${i}:00+00:00` }))
  const fakeRpc = (rows: MessageRow[]) => {
    const calls: Array<Record<string, unknown>> = []
    const db = {
      rpc: async (_name: string, args: Record<string, unknown>) => (calls.push(args), { data: rows, error: null }),
      from: () => {
        const b: Record<string, any> = {}
        b.select = () => b
        b.eq = () => b
        b.in = () => b
        b.then = (r: (v: unknown) => void) => r({ data: [], error: null })
        return b
      },
    }
    return { db: db as never, calls }
  }

  it('pede limit+1 ao banco, devolve só limit itens e o cursor da última devolvida', async () => {
    const { db, calls } = fakeRpc(rowsFor(3))
    const page = await loadMessagePage(db, { accountId: 'acc', conversationId: 'c1', cursor: null, limit: 2, includeMediaUrls: false })
    expect(calls[0]).toMatchObject({ p_account_id: 'acc', p_conversation_id: 'c1', p_limit: 3 })
    expect(page.items.map((i) => i.id)).toEqual(['m1', 'm2'])
    expect(decodeCursor(page.next_cursor, 2)).toEqual(['2026-10-08T14:01:00+00:00', 'm2'])
  })
  it('última página: next_cursor nulo; o cursor volta ao banco como p_after_*', async () => {
    const { db, calls } = fakeRpc(rowsFor(2))
    const page = await loadMessagePage(db, { accountId: 'acc', cursor: ['2026-10-08T13:00:00+00:00', 'mX'], limit: 5, includeMediaUrls: false })
    expect(page.next_cursor).toBeNull()
    expect(calls[0]).toMatchObject({ p_after_at: '2026-10-08T13:00:00+00:00', p_after_id: 'mX', p_conversation_id: null })
  })
  it('função ausente (migration 330 não aplicada) = 503', async () => {
    const db = { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) } as never
    await expect(loadMessagePage(db, { accountId: 'acc', cursor: null, limit: 5, includeMediaUrls: false })).rejects.toMatchObject({ status: 503 })
  })
})

describe('loadConversationPage', () => {
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {
    conversations: [
      { id: 'c1', account_id: 'acc', contact_id: 'ct1', status: 'closed', channel_type: null, assigned_agent_id: 'u1', team_id: 't1', outcome_tag_id: 'tg1', created_at: '2026-10-01T10:00:00+00:00', updated_at: '2026-10-01T11:00:00+00:00', first_response_at: '2026-10-01T10:01:00+00:00', closed_at: '2026-10-01T11:00:00+00:00' },
      { id: 'c2', account_id: 'acc', contact_id: 'ct1', status: 'open', channel_type: 'webchat', assigned_agent_id: null, team_id: null, outcome_tag_id: null, created_at: '2026-10-02T10:00:00+00:00', updated_at: '2026-10-02T11:00:00+00:00', first_response_at: null, closed_at: null },
      { id: 'cX', account_id: 'outra', contact_id: 'ct9', status: 'open', channel_type: null, assigned_agent_id: null, team_id: null, outcome_tag_id: null, created_at: '2026-10-01T10:00:00+00:00', updated_at: '2026-10-01T12:00:00+00:00', first_response_at: null, closed_at: null },
    ],
    contacts: [{ id: 'ct1', account_id: 'acc', name: 'Carlos', phone: '5511999998888', cpf: '12345678900', email: 'c@x.com' }],
    profiles: [{ account_id: 'acc', user_id: 'u1', full_name: 'Ana' }],
    teams: [{ account_id: 'acc', id: 't1', name: 'Cobrança' }],
    tags: [{ account_id: 'acc', id: 'tg1', name: 'Acordo', codigo_tabulacao: 7 }],
    conversation_assignments: [{ account_id: 'acc', conversation_id: 'c1', from_agent_id: null, to_agent_id: 'u1', from_team_id: null, to_team_id: 't1', reason: 'fluxo', created_at: '2026-10-01T10:00:05+00:00' }],
  }
  const selected: string[] = []
  const db = {
    rpc: async (name: string, args: { p_ids: string[] }) =>
      name === 'api_v1_conversation_message_counts' ? { data: args.p_ids.map((id) => ({ conversation_id: id, message_count: id === 'c1' ? '12' : 3 })), error: null } : { data: null, error: null },
    from(table: string) {
      let rows = [...(tables[table] ?? [])]
      let lim = Infinity
      const b: Record<string, any> = {}
      b.select = (cols: string) => (selected.push(`${table}:${cols}`), b)
      b.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b)
      b.in = (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b)
      b.gte = () => b
      b.lt = () => b
      b.not = () => b
      b.or = () => b
      b.order = (c: string) => ((rows = rows.sort((x, y) => (String(x[c]) < String(y[c]) ? -1 : 1))), b)
      b.limit = (n: number) => ((lim = n), b)
      b.then = (r: (v: unknown) => void) => r({ data: rows.slice(0, lim), error: null })
      return b
    },
  } as never
  const filters = parseConversationFilters(new URLSearchParams(''))

  it('monta a conversa com equipe, atendente, tabulação, contato (só id/nome/telefone), contagem e transferências', async () => {
    const page = await loadConversationPage(db, { accountId: 'acc', filters, cursor: null, limit: 10 })
    expect(page.items.map((c) => c.id)).toEqual(['c1', 'c2']) // a de outra conta nunca entra
    expect(page.items[0]).toMatchObject({
      channel: 'whatsapp', status: 'closed', message_count: 12,
      team: { id: 't1', name: 'Cobrança' }, assigned_agent: { id: 'u1', name: 'Ana' }, outcome_tag: { id: 'tg1', name: 'Acordo', codigo: 7 },
      contact: { id: 'ct1', name: 'Carlos', phone: '5511999998888' },
    })
    expect(page.items[0].assignments).toEqual([
      { at: '2026-10-01T10:00:05.000Z', from_agent: null, to_agent: { id: 'u1', name: 'Ana' }, from_team: null, to_team: { id: 't1', name: 'Cobrança' }, reason: 'fluxo' },
    ])
    expect(page.items[1]).toMatchObject({ channel: 'webchat', team: null, assigned_agent: null, outcome_tag: null })
    expect(page.next_cursor).toBeNull()
  })
  it('CPF e e-mail do contato nem são lidos (o select só pede id, name e phone)', async () => {
    selected.length = 0
    const page = await loadConversationPage(db, { accountId: 'acc', filters, cursor: null, limit: 10 })
    expect(JSON.stringify(page)).not.toContain('12345678900')
    expect(JSON.stringify(page)).not.toContain('c@x.com')
    expect(selected).toContain('contacts:id, name, phone')
  })
  it('cursor de outra ordenação é recusado; limite pagina e devolve next_cursor com o campo de ordenação', async () => {
    const first = await loadConversationPage(db, { accountId: 'acc', filters, cursor: null, limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(decodeCursor(first.next_cursor, 3)?.[0]).toBe('updated_at')
    await expect(
      loadConversationPage(db, { accountId: 'acc', filters: parseConversationFilters(new URLSearchParams('closed_from=2026-10-01')), cursor: ['updated_at', 'x', 'y'], limit: 5 }),
    ).rejects.toMatchObject({ status: 400 })
  })
})
