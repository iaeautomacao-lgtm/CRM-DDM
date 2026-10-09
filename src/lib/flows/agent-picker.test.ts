import { describe, expect, it } from 'vitest'
import { createMemoryDb, type SimTables } from './simulator/memory-db'
import {
  PICKER_IDS_VAR,
  buildPickerMenu,
  chosenAgentFromReply,
  isPickerReplyId,
  listOnlineAgents,
  pickerNoAgentTarget,
  pickerTemplateRow,
} from './agent-picker'
import { matchReplyId } from './engine'
import type { SendListNodeConfig } from './types'

const ACC = 'acc-1'
const NOW = Date.parse('2026-10-09T12:00:00Z')
const seen = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString()

function tables(over: Partial<SimTables> = {}): SimTables {
  return {
    team_members: [
      { team_id: 't1', user_id: 'u1', created_at: '2026-01-01T00:00:00Z' },
      { team_id: 't1', user_id: 'u2', created_at: '2026-01-02T00:00:00Z' },
      { team_id: 't1', user_id: 'u3', created_at: '2026-01-03T00:00:00Z' },
      { team_id: 't1', user_id: 'u4', created_at: '2026-01-04T00:00:00Z' },
      { team_id: 't1', user_id: 'admin', created_at: '2026-01-05T00:00:00Z' },
      { team_id: 't2', user_id: 'outro', created_at: '2026-01-06T00:00:00Z' },
    ],
    profiles: [
      { user_id: 'u1', account_id: ACC, account_role: 'agent', full_name: 'Ana', max_simultaneous_chats: null },
      { user_id: 'u2', account_id: ACC, account_role: 'agent', full_name: 'Bruno com um nome extremamente comprido', max_simultaneous_chats: 1 },
      { user_id: 'u3', account_id: ACC, account_role: 'agent', full_name: 'Carla', max_simultaneous_chats: null },
      { user_id: 'u4', account_id: ACC, account_role: 'agent', full_name: null, max_simultaneous_chats: null },
      { user_id: 'admin', account_id: ACC, account_role: 'admin', full_name: 'Admin', max_simultaneous_chats: null },
      { user_id: 'outro', account_id: 'acc-2', account_role: 'agent', full_name: 'De outra conta', max_simultaneous_chats: null },
    ],
    member_presence: [
      { user_id: 'u1', status: 'online', last_seen_at: seen(10) },
      { user_id: 'u2', status: 'online', last_seen_at: seen(20) },
      { user_id: 'u3', status: 'away', last_seen_at: seen(10) }, // away fica de fora
      { user_id: 'u4', status: 'online', last_seen_at: seen(300) }, // visto há 5 min = offline
      { user_id: 'admin', status: 'online', last_seen_at: seen(5) }, // não é Operador
      { user_id: 'outro', status: 'online', last_seen_at: seen(5) },
    ],
    conversations: [{ id: 'c1', assigned_agent_id: 'u2', status: 'open' }], // u2 já está no teto (max 1)
    ...over,
  }
}
const dbOf = (t: SimTables) => createMemoryDb({ tables: t, clock: { last: 0 } })

describe('listOnlineAgents', () => {
  it('só Operadores da conta, da equipe, ONLINE (75 s), abaixo do teto de conversas', async () => {
    const agents = await listOnlineAgents(dbOf(tables()), ACC, 't1', NOW)
    expect(agents).toEqual([{ user_id: 'u1', name: 'Ana' }])
  })

  it('com capacidade sobrando o operador entra; sem nome vira "Atendente"', async () => {
    const t = tables({ conversations: [] })
    t.member_presence!.push({ user_id: 'u4', status: 'online', last_seen_at: seen(1) })
    t.member_presence = t.member_presence!.filter((p) => !(p.user_id === 'u4' && p.last_seen_at === seen(300)))
    const agents = await listOnlineAgents(dbOf(t), ACC, 't1', NOW)
    expect(agents.map((a) => a.user_id)).toEqual(['u1', 'u2', 'u4']) // ordem de entrada na equipe
    expect(agents.find((a) => a.user_id === 'u4')?.name).toBe('Atendente')
  })

  it('sem team_id usa os Operadores da conta (nunca de outra conta)', async () => {
    const agents = await listOnlineAgents(dbOf(tables({ conversations: [] })), ACC, undefined, NOW)
    expect(agents.map((a) => a.user_id)).toEqual(['u1', 'u2'])
  })

  it('equipe vazia ou erro ⇒ lista vazia (fila normal), sem lançar', async () => {
    expect(await listOnlineAgents(dbOf(tables()), ACC, 'equipe-inexistente', NOW)).toEqual([])
    const broken = { from: () => { throw new Error('boom') } } as never
    expect(await listOnlineAgents(broken, ACC, 't1', NOW)).toEqual([])
  })
})

const cfg = (extra: Partial<SendListNodeConfig> = {}): SendListNodeConfig => ({
  text: 'Com quem você quer falar?',
  button_label: 'Escolher',
  sections: [{ rows: [
    { reply_id: 'modelo', title: 'Atendente', next_node_key: 'h_agente' },
    { reply_id: '__no_agent', title: 'ninguém', next_node_key: 'h_fila' },
  ] }],
  agent_picker: { team_id: 't1' },
  ...extra,
})

describe('buildPickerMenu', () => {
  const agents = [{ user_id: 'u1', name: 'Ana' }, { user_id: 'u2', name: 'Bruno com um nome extremamente comprido' }]

  it('uma linha por operador (reply_id agent:<id>, destino do modelo); título cortado em 24; a linha "__no_agent" nunca aparece', () => {
    const menu = buildPickerMenu(cfg(), agents)!
    expect(menu.agentIds).toEqual(['u1', 'u2'])
    const rows = menu.cfg.sections.flatMap((s) => s.rows)
    expect(rows.map((r) => r.reply_id)).toEqual(['agent:u1', 'agent:u2'])
    expect(rows.every((r) => r.next_node_key === 'h_agente')).toBe(true)
    expect(rows[1].title.length).toBeLessThanOrEqual(24)
    expect(rows[1].title.endsWith('…')).toBe(true)
  })

  it('respeita max_options (teto 10 da lista do WhatsApp); sem operador ou sem modelo ⇒ null', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ user_id: `x${i}`, name: `Op ${i}` }))
    expect(buildPickerMenu(cfg(), many)!.agentIds).toHaveLength(10)
    expect(buildPickerMenu(cfg({ agent_picker: { team_id: 't1', max_options: 3 } }), many)!.agentIds).toHaveLength(3)
    expect(buildPickerMenu(cfg(), [])).toBeNull()
    expect(buildPickerMenu(cfg({ sections: [{ rows: [{ reply_id: '__no_agent', title: 'x', next_node_key: 'h' }] }] }), agents)).toBeNull()
  })

  it('linha-modelo e destino "sem operador" lidos da topologia do nó', () => {
    expect(pickerTemplateRow(cfg())?.next_node_key).toBe('h_agente')
    expect(pickerNoAgentTarget(cfg())).toBe('h_fila')
    expect(pickerNoAgentTarget(cfg({ sections: [{ rows: [{ reply_id: 'm', title: 'x', next_node_key: 'a' }] }] }))).toBeNull()
  })
})

describe('resposta do cliente', () => {
  it('chosenAgentFromReply só aceita ids que estavam no menu enviado por ESTE run', () => {
    const vars = { [PICKER_IDS_VAR]: ['u1', 'u2'] }
    expect(chosenAgentFromReply('agent:u2', vars)).toBe('u2')
    expect(chosenAgentFromReply('agent:invasor', vars)).toBeNull()
    expect(chosenAgentFromReply('agent:u2', {})).toBeNull()
    expect(chosenAgentFromReply('agent:', vars)).toBeNull()
    expect(chosenAgentFromReply('outra_coisa', vars)).toBeNull()
    expect(isPickerReplyId('agent:u1')).toBe(true)
    expect(isPickerReplyId('agent:')).toBe(false)
  })

  it('matchReplyId do send_list com agent_picker roteia agent:<id> para o destino do modelo; sem agent_picker nada muda', () => {
    expect(matchReplyId({ node_type: 'send_list', config: cfg() as unknown as Record<string, unknown> }, 'agent:u1')).toBe('h_agente')
    expect(matchReplyId({ node_type: 'send_list', config: cfg() as unknown as Record<string, unknown> }, 'modelo')).toBe('h_agente')
    const plain = cfg({ agent_picker: undefined })
    expect(matchReplyId({ node_type: 'send_list', config: plain as unknown as Record<string, unknown> }, 'agent:u1')).toBeNull()
  })
})
