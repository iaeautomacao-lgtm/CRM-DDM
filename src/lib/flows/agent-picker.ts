// Menu "escolha seu atendente" do Flow Builder (PRD 23, item 16): o cliente escolhe, numa lista do WhatsApp, entre os operadores ONLINE da
// equipe e a conversa é atribuída a quem ele escolheu. Ninguém online ⇒ fila normal (handoff de equipe).
//
// Contrato (sem nó novo — reaproveita o send_list, que já sabe suspender, rotear a resposta e funcionar em Meta e WAHA):
//   send_list.config.agent_picker = { team_id?: string, max_options?: number }
//   sections[].rows do nó, só como TOPOLOGIA (o canvas/validador já entendem essas arestas):
//     - 1ª linha com reply_id ≠ "__no_agent" = MODELO: seu next_node_key é para onde vai quem escolheu um operador (um handoff_agent com
//       `assign_from_var: "chosen_agent_id"`); título/descrição dela não aparecem;
//     - linha com reply_id "__no_agent" (opcional) = destino quando NINGUÉM está online (ex.: um handoff_team). Nunca aparece no menu.
//   Em tempo de execução as linhas do menu são geradas: uma por operador online, reply_id "agent:<user_id>", mesmo destino do modelo.
// Online = member_presence 'online' visto nos últimos 75 s (mesma régua da seleção automática), só Operadores (account_role = 'agent'),
// abaixo do teto de max_simultaneous_chats. Away fica de fora. Nada aqui toca na truncagem do engine nem no hasRunLeftNodeSnapshot.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SendListNodeConfig } from '@/lib/flows/types'

export const PICKER_NO_AGENT_REPLY_ID = '__no_agent'
export const PICKER_REPLY_PREFIX = 'agent:'
export const PICKER_IDS_VAR = '__agent_picker_ids'
export const PICKER_CHOSEN_VAR = 'chosen_agent_id'
export const PICKER_MAX_OPTIONS = 10
const ROW_TITLE_MAX = 24
const ONLINE_WINDOW_MS = 75_000

type Db = Pick<SupabaseClient, 'from'>
export interface PickerAgent {
  user_id: string
  name: string
}

type Row = SendListNodeConfig['sections'][number]['rows'][number]

const allRows = (cfg: Pick<SendListNodeConfig, 'sections'>): Row[] => (cfg.sections ?? []).flatMap((s) => s.rows ?? [])

/** Linha-modelo: destino de quem escolheu um operador. */
export function pickerTemplateRow(cfg: Pick<SendListNodeConfig, 'sections'>): Row | null {
  return allRows(cfg).find((r) => r.reply_id !== PICKER_NO_AGENT_REPLY_ID) ?? null
}

/** Destino quando ninguém está online (null = sem linha configurada → fila normal da equipe). */
export function pickerNoAgentTarget(cfg: Pick<SendListNodeConfig, 'sections'>): string | null {
  return allRows(cfg).find((r) => r.reply_id === PICKER_NO_AGENT_REPLY_ID)?.next_node_key ?? null
}

export const isPickerReplyId = (replyId: string): boolean => replyId.startsWith(PICKER_REPLY_PREFIX) && replyId.length > PICKER_REPLY_PREFIX.length

/** Operadores online da equipe (ou da conta, sem team_id), com capacidade, mais antigos primeiro. Nunca lança: erro ⇒ lista vazia (fila normal). */
export async function listOnlineAgents(
  db: Db,
  accountId: string,
  teamId: string | null | undefined,
  now: number = Date.now(),
): Promise<PickerAgent[]> {
  try {
    let candidateIds: string[]
    if (teamId) {
      const { data: members, error } = await db.from('team_members').select('user_id').eq('team_id', teamId).order('created_at', { ascending: true })
      if (error || !members?.length) return []
      candidateIds = (members as Array<{ user_id: string }>).map((m) => m.user_id)
    } else {
      const { data: all, error } = await db.from('profiles').select('user_id').eq('account_id', accountId).eq('account_role', 'agent').order('created_at', { ascending: true })
      if (error || !all?.length) return []
      candidateIds = (all as Array<{ user_id: string }>).map((m) => m.user_id)
    }

    // Só Operadores da MESMA conta (a conta do run, nunca a do conteúdo do fluxo).
    const { data: profiles } = await db
      .from('profiles')
      .select('user_id, full_name, max_simultaneous_chats')
      .eq('account_id', accountId)
      .eq('account_role', 'agent')
      .in('user_id', candidateIds)
    const byId = new Map((profiles as Array<{ user_id: string; full_name: string | null; max_simultaneous_chats: number | null }> | null ?? []).map((p) => [p.user_id, p]))
    const ordered = candidateIds.filter((id) => byId.has(id))
    if (ordered.length === 0) return []

    const cutoff = new Date(now - ONLINE_WINDOW_MS).toISOString()
    const { data: online } = await db.from('member_presence').select('user_id').in('user_id', ordered).eq('status', 'online').gte('last_seen_at', cutoff)
    const onlineIds = new Set((online as Array<{ user_id: string }> | null ?? []).map((r) => r.user_id))
    const eligible = ordered.filter((id) => onlineIds.has(id))
    if (eligible.length === 0) return []

    const { data: open } = await db.from('conversations').select('assigned_agent_id').in('assigned_agent_id', eligible).in('status', ['open', 'pending'])
    const counts = new Map<string, number>(eligible.map((id) => [id, 0]))
    for (const row of (open as Array<{ assigned_agent_id: string | null }> | null) ?? []) {
      if (row.assigned_agent_id && counts.has(row.assigned_agent_id)) counts.set(row.assigned_agent_id, (counts.get(row.assigned_agent_id) ?? 0) + 1)
    }
    return eligible
      .filter((id) => {
        const max = byId.get(id)?.max_simultaneous_chats
        return max === null || max === undefined || (counts.get(id) ?? 0) < max
      })
      .map((id) => ({ user_id: id, name: (byId.get(id)?.full_name ?? '').trim() || 'Atendente' }))
  } catch {
    return []
  }
}

/** Menu pronto (config com as linhas geradas) e os ids oferecidos; null = ninguém para oferecer (usar o destino "sem operador"). */
export function buildPickerMenu(
  cfg: SendListNodeConfig,
  agents: readonly PickerAgent[],
): { cfg: SendListNodeConfig; agentIds: string[] } | null {
  const template = pickerTemplateRow(cfg)
  const max = Math.min(Math.max(Math.floor(cfg.agent_picker?.max_options ?? PICKER_MAX_OPTIONS), 1), PICKER_MAX_OPTIONS)
  const offered = agents.slice(0, max)
  if (!template || offered.length === 0) return null
  const rows: Row[] = offered.map((a) => ({
    reply_id: `${PICKER_REPLY_PREFIX}${a.user_id}`,
    title: a.name.length > ROW_TITLE_MAX ? `${a.name.slice(0, ROW_TITLE_MAX - 1)}…` : a.name,
    next_node_key: template.next_node_key,
  }))
  return { cfg: { ...cfg, sections: [{ rows }] }, agentIds: offered.map((a) => a.user_id) }
}

/**
 * Operador escolhido pelo cliente: só vale se estava no menu que ESTE run enviou (guardado em vars) — um reply_id inventado
 * (ou de um menu anterior) não atribui ninguém. Devolve o user_id ou null.
 */
export function chosenAgentFromReply(replyId: string, vars: Record<string, unknown> | null | undefined): string | null {
  if (!isPickerReplyId(replyId)) return null
  const id = replyId.slice(PICKER_REPLY_PREFIX.length)
  const offered = vars?.[PICKER_IDS_VAR]
  return Array.isArray(offered) && offered.includes(id) ? id : null
}
