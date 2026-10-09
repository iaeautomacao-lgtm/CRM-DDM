import { describe, expect, it } from 'vitest'
import {
  assignmentItem, compareActivity, decodeCursor, dealItems, encodeCursor, eventItem, loadActivity, loadContactCampaigns, messageItem, noteItem,
  parseActivityTypes, parseLimit,
} from './contact-timeline'

type Row = Record<string, unknown>

/** Supabase em memória: só o que o módulo usa (eq/in/lt/or/order/limit), com filtros reais. */
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])]
      let limitN = Infinity
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b)
      b.in = (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b)
      b.lt = (c: string, v: string) => ((rows = rows.filter((r) => Date.parse(String(r[c])) < Date.parse(v))), b)
      b.or = (expr: string) => {
        const m = /scheduled_at\.lt\."([^"]+)",and\(scheduled_at\.eq\."[^"]+",id\.lt\."([^"]+)"\)/.exec(expr)!
        rows = rows.filter((r) => String(r.scheduled_at) < m[1] || (r.scheduled_at === m[1] && String(r.id) < m[2]))
        return b
      }
      b.order = (c: string, o: { ascending: boolean }) => {
        rows.sort((x, y) => (String(x[c]) < String(y[c]) ? 1 : String(x[c]) > String(y[c]) ? -1 : 0) * (o.ascending ? -1 : 1))
        return b
      }
      b.limit = (n: number) => ((limitN = n), b)
      b.then = (resolve: (v: unknown) => void) => resolve({ data: rows.slice(0, limitN), error: null })
      return b
    },
  } as never
}

const ACC = 'acc'
const C = 'contact-1'

describe('helpers', () => {
  it('limit: padrão 30, teto 100, inválido volta ao padrão', () => {
    expect(parseLimit(null)).toBe(30)
    expect(parseLimit('500')).toBe(100)
    expect(parseLimit('abc')).toBe(30)
    expect(parseLimit('0')).toBe(30)
    expect(parseLimit('5')).toBe(5)
  })
  it('cursor: ida e volta; lixo = invalid; ausente = null', () => {
    expect(decodeCursor(encodeCursor(['1', 'k']))).toEqual(['1', 'k'])
    expect(decodeCursor('%%%')).toBe('invalid')
    expect(decodeCursor(null)).toBeNull()
  })
  it('types: só os 5 conhecidos', () => {
    expect(parseActivityTypes(null)).toHaveLength(5)
    expect(parseActivityTypes('note,message')).toEqual(['note', 'message'])
    expect(parseActivityTypes('foo')).toBe('invalid')
  })
  it('mensagem: direção, atribuição da IA e rótulo de mídia; texto cortado em 160', () => {
    const base = { id: 'm1', conversation_id: 'c1', created_at: '2026-10-09T12:00:00Z' }
    expect(messageItem({ ...base, sender_type: 'customer', content_text: 'oi' })).toMatchObject({ direction: 'in', title: 'Mensagem recebida', detail: 'oi' })
    expect(messageItem({ ...base, sender_type: 'bot', content_text: 'x' })).toMatchObject({ direction: 'out', sender: 'bot', title: 'Resposta da IA' })
    expect(messageItem({ ...base, sender_type: 'agent', content_type: 'audio', content_text: null })).toMatchObject({ detail: '[áudio]', title: 'Mensagem enviada' })
    expect(messageItem({ ...base, sender_type: 'customer', content_text: 'a'.repeat(500) })?.detail).toHaveLength(160)
  })
  it('evento: usa o resumo da auditoria e o nome de quem fez', () => {
    expect(eventItem({ id: 'e', created_at: '2026-10-09T12:00:00Z', summary: 'Etiqueta X adicionada', user_name: 'Ana', event_type: 'updated' }))
      .toMatchObject({ title: 'Etiqueta X adicionada', actor: { name: 'Ana' }, type: 'event' })
  })
  it('nota: autor pelo perfil', () => {
    expect(noteItem({ id: 'n', user_id: 'u', note_text: 'ligar amanhã', created_at: '2026-10-09T12:00:00Z' }, new Map([['u', 'Bia']])))
      .toMatchObject({ type: 'note', detail: 'ligar amanhã', actor: { name: 'Bia' } })
  })
  it('negócio: criado + etapa atual só se alterado depois (o funil não guarda histórico)', () => {
    expect(dealItems({ id: 'd', title: 'Acordo', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' }, 'Novo')).toHaveLength(1)
    const two = dealItems({ id: 'd', title: 'Acordo', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-05T10:00:00Z' }, 'Negociação')
    expect(two.map((i) => i.title)).toEqual(['Negócio criado', 'Negócio atualizado — etapa atual: Negociação'])
  })
  it('atribuição: agente, equipe e sistema (actor nulo)', () => {
    const names = { agents: new Map([['a1', 'Carlos']]), teams: new Map([['t1', 'Cobrança']]) }
    const row = { id: 'x', conversation_id: 'c1', created_at: '2026-10-09T12:00:00Z', reason: 'fluxo' }
    expect(assignmentItem({ ...row, to_agent_id: 'a1' }, names)).toMatchObject({ title: 'Conversa atribuída a Carlos', actor: null, detail: 'fluxo' })
    expect(assignmentItem({ ...row, to_team_id: 't1' }, names)?.title).toBe('Conversa transferida para a equipe Cobrança')
  })
  it('ordem: mais novo primeiro, empate pelo key', () => {
    const l = [{ at: '2026-10-09T10:00:00Z', key: 'a' }, { at: '2026-10-09T11:00:00Z', key: 'a' }, { at: '2026-10-09T11:00:00Z', key: 'b' }]
    expect(l.sort(compareActivity).map((i) => `${i.at.slice(11, 13)}${i.key}`)).toEqual(['11b', '11a', '10a'])
  })
})

describe('loadActivity', () => {
  const t = (h: number, m = 0) => `2026-10-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`
  const tables = (): Record<string, Row[]> => ({
    conversations: [{ id: 'c1', account_id: ACC, contact_id: C, last_message_at: t(9) }, { id: 'cX', account_id: 'other', contact_id: C, last_message_at: t(9) }],
    messages: [
      { id: 'm1', conversation_id: 'c1', sender_type: 'customer', content_text: 'oi', created_at: t(9) },
      { id: 'm2', conversation_id: 'c1', sender_type: 'agent', content_text: 'olá', created_at: t(10) },
      { id: 'mX', conversation_id: 'cOutra', sender_type: 'customer', content_text: 'vazou', created_at: t(11) },
    ],
    audit_logs: [
      { id: 'a1', account_id: ACC, resource_type: 'contact', resource_id: C, event_type: 'updated', summary: 'Etiqueta VIP adicionada', user_name: 'Ana', created_at: t(9, 30) },
      { id: 'a2', account_id: 'other', resource_type: 'contact', resource_id: C, event_type: 'updated', summary: 'de outra conta', created_at: t(9, 45) },
    ],
    contact_notes: [{ id: 'n1', contact_id: C, user_id: 'u1', note_text: 'nota', created_at: t(8) }],
    profiles: [{ user_id: 'u1', full_name: 'Bia' }],
    deals: [], conversation_assignments: [], teams: [], pipeline_stages: [],
  })

  it('funde as fontes por data (mais novo primeiro) e isola conta/contato', async () => {
    const r = await loadActivity(fakeDb(tables()), ACC, C, { limit: 30, cursor: null, types: ['message', 'event', 'note', 'deal', 'assignment'] })
    expect(r.items.map((i) => i.key)).toEqual(['message:m2', 'event:a1', 'message:m1', 'note:n1'])
    expect(r.next_cursor).toBeNull()
    expect(r.items.find((i) => i.key === 'note:n1')?.actor).toEqual({ name: 'Bia' })
  })

  it('pagina por cursor sem repetir nem pular itens', async () => {
    const db = fakeDb(tables())
    const types = ['message', 'event', 'note'] as const
    const first = await loadActivity(db, ACC, C, { limit: 2, cursor: null, types: [...types] })
    expect(first.items.map((i) => i.key)).toEqual(['message:m2', 'event:a1'])
    expect(first.next_cursor).not.toBeNull()
    const second = await loadActivity(db, ACC, C, { limit: 2, cursor: decodeCursor(first.next_cursor) as [string, string], types: [...types] })
    expect(second.items.map((i) => i.key)).toEqual(['message:m1', 'note:n1'])
    expect(second.next_cursor).toBeNull()
  })

  it('types restringe as fontes consultadas', async () => {
    const r = await loadActivity(fakeDb(tables()), ACC, C, { limit: 30, cursor: null, types: ['note'] })
    expect(r.items.map((i) => i.type)).toEqual(['note'])
  })
})

describe('loadContactCampaigns', () => {
  const rows = (): Record<string, Row[]> => ({
    disp_message_queue: [
      { id: 'q3', account_id: ACC, contact_id: C, campaign_id: 'k1', status: 'erro', erro: 'número inválido', scheduled_at: '2026-10-09T12:00:00+00:00', sent_at: null, replied_at: null, template_name: 'cobranca' },
      { id: 'q2', account_id: ACC, contact_id: C, campaign_id: 'k1', status: 'lido', erro: 'ruído', scheduled_at: '2026-10-08T12:00:00+00:00', sent_at: '2026-10-08T12:00:05+00:00', replied_at: null, template_name: 'cobranca' },
      { id: 'q1', account_id: ACC, contact_id: C, campaign_id: 'k2', status: 'enviado', erro: null, scheduled_at: '2026-10-07T12:00:00+00:00', sent_at: '2026-10-07T12:00:01+00:00', replied_at: '2026-10-07T13:00:00+00:00', template_name: null },
      { id: 'qX', account_id: 'other', contact_id: C, campaign_id: 'k9', status: 'enviado', scheduled_at: '2026-10-09T13:00:00+00:00' },
    ],
    campaigns: [{ id: 'k1', account_id: ACC, nome: 'Cobrança Out', status: 'em_execucao' }, { id: 'k2', account_id: ACC, nome: 'Boas-vindas', status: 'encerrada' }],
  })

  it('traz a campanha, mostra erro só em erro/bloqueado e não vaza outra conta', async () => {
    const r = await loadContactCampaigns(fakeDb(rows()), ACC, C, { limit: 20, cursor: null })
    expect(r.items.map((i) => i.id)).toEqual(['q3', 'q2', 'q1'])
    expect(r.items[0]).toMatchObject({ campaign_name: 'Cobrança Out', campaign_status: 'em_execucao', status: 'erro', error: 'número inválido' })
    expect(r.items[1].error).toBeNull()
    expect(r.items[2]).toMatchObject({ campaign_name: 'Boas-vindas', replied_at: '2026-10-07T13:00:00+00:00' })
    expect(r.next_cursor).toBeNull()
  })

  it('pagina por cursor', async () => {
    const db = fakeDb(rows())
    const first = await loadContactCampaigns(db, ACC, C, { limit: 2, cursor: null })
    expect(first.items.map((i) => i.id)).toEqual(['q3', 'q2'])
    const second = await loadContactCampaigns(db, ACC, C, { limit: 2, cursor: decodeCursor(first.next_cursor) as [string, string] })
    expect(second.items.map((i) => i.id)).toEqual(['q1'])
    expect(second.next_cursor).toBeNull()
  })
})
