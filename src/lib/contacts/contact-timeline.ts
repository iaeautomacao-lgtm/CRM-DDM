import type { SupabaseClient } from '@supabase/supabase-js'

// Abas "Atividade" e "Campanhas" do contato (TASK36 item 1). Só LÊ o que o sistema já registra (mensagens, audit_logs, notas,
// negócios, atribuições, fila do disparador); nenhum registro de evento novo. Paginação por cursor opaco (keyset).

export const ACTIVITY_TYPES = ['message', 'event', 'note', 'deal', 'assignment'] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export interface ActivityItem {
  key: string
  type: ActivityType
  at: string
  title: string
  detail: string | null
  actor: { name: string } | null
  conversation_id: string | null
  /** Só em type 'message': 'in' = cliente, 'out' = agente ou IA. */
  direction: 'in' | 'out' | null
  sender: 'customer' | 'agent' | 'bot' | null
}

export const DEFAULT_PAGE = 30
export const MAX_PAGE = 100
const MESSAGE_DETAIL_MAX = 160
const CONVERSATION_IDS_MAX = 200

export function parseLimit(raw: string | null): number {
  const n = Math.floor(Number(raw ?? DEFAULT_PAGE))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE
  return Math.min(n, MAX_PAGE)
}

export function encodeCursor(parts: [string, string]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url')
}

export function decodeCursor(raw: string | null): [string, string] | null | 'invalid' {
  if (!raw) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && v[0].length < 80 && v[1].length < 80) {
      return [v[0], v[1]]
    }
  } catch {
    /* cai no inválido */
  }
  return 'invalid'
}

export function parseActivityTypes(raw: string | null): ActivityType[] | 'invalid' {
  if (!raw) return [...ACTIVITY_TYPES]
  const wanted = raw.split(',').map((t) => t.trim()).filter(Boolean)
  if (wanted.length === 0 || wanted.some((t) => !(ACTIVITY_TYPES as readonly string[]).includes(t))) return 'invalid'
  return [...new Set(wanted)] as ActivityType[]
}

type Row = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const ms = (iso: string) => Date.parse(iso)

/** Ordem do mais novo para o mais antigo; empate pelo key (mesma ordem do cursor). */
export function compareActivity(a: { at: string; key: string }, b: { at: string; key: string }): number {
  return ms(b.at) - ms(a.at) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)
}

/** Já passou do cursor? (estritamente depois dele na ordem decrescente) */
function afterCursor(item: { at: string; key: string }, cursor: [string, string] | null): boolean {
  if (!cursor) return true
  const t = ms(item.at)
  const c = Number(cursor[0])
  return t < c || (t === c && item.key < cursor[1])
}

const MEDIA_LABEL: Record<string, string> = {
  image: '[imagem]', audio: '[áudio]', video: '[vídeo]', document: '[documento]', location: '[localização]', template: '[modelo de mensagem]',
}

export function messageItem(row: Row): ActivityItem | null {
  const id = str(row.id)
  const at = str(row.created_at)
  if (!id || !at) return null
  const sender = row.sender_type === 'agent' || row.sender_type === 'bot' ? row.sender_type : 'customer'
  const text = str(row.content_text)
  const kind = str(row.content_type) ?? 'text'
  const detail = text ? text.slice(0, MESSAGE_DETAIL_MAX) : (MEDIA_LABEL[kind] ?? null)
  return {
    key: `message:${id}`,
    type: 'message',
    at,
    title: sender === 'customer' ? 'Mensagem recebida' : sender === 'bot' ? 'Resposta da IA' : 'Mensagem enviada',
    detail,
    actor: null,
    conversation_id: str(row.conversation_id),
    direction: sender === 'customer' ? 'in' : 'out',
    sender,
  }
}

const base = (key: string, type: ActivityType, at: string, title: string): ActivityItem => ({
  key, type, at, title, detail: null, actor: null, conversation_id: null, direction: null, sender: null,
})

export function eventItem(row: Row): ActivityItem | null {
  const id = str(row.id)
  const at = str(row.created_at)
  if (!id || !at) return null
  const it = base(`event:${id}`, 'event', at, str(row.summary) ?? ({ created: 'Contato criado', updated: 'Contato editado', deleted: 'Contato excluído' } as Record<string, string>)[String(row.event_type)] ?? 'Alteração no contato')
  const name = str(row.user_name)
  it.actor = name ? { name } : null
  return it
}

export function noteItem(row: Row, authors: Map<string, string>): ActivityItem | null {
  const id = str(row.id)
  const at = str(row.created_at)
  if (!id || !at) return null
  const it = base(`note:${id}`, 'note', at, 'Nota adicionada')
  it.detail = (str(row.note_text) ?? '').slice(0, MESSAGE_DETAIL_MAX) || null
  const author = authors.get(String(row.user_id))
  it.actor = author ? { name: author } : null
  return it
}

export function dealItems(row: Row, stageName: string | null): ActivityItem[] {
  const id = str(row.id)
  const created = str(row.created_at)
  if (!id || !created) return []
  const title = str(row.title) ?? 'Negócio'
  const out = [{ ...base(`deal:${id}:created`, 'deal', created, 'Negócio criado'), detail: title }]
  const updated = str(row.updated_at)
  // O funil não guarda histórico de movimentação: só a etapa ATUAL, quando houve alteração depois da criação.
  if (updated && ms(updated) - ms(created) > 1000) {
    out.push({ ...base(`deal:${id}:updated`, 'deal', updated, stageName ? `Negócio atualizado — etapa atual: ${stageName}` : 'Negócio atualizado'), detail: title })
  }
  return out
}

export function assignmentItem(row: Row, names: { agents: Map<string, string>; teams: Map<string, string> }): ActivityItem | null {
  const id = str(row.id)
  const at = str(row.created_at)
  if (!id || !at) return null
  const to = names.agents.get(String(row.to_agent_id))
  const toTeam = names.teams.get(String(row.to_team_id))
  const title = to
    ? `Conversa atribuída a ${to}`
    : toTeam
      ? `Conversa transferida para a equipe ${toTeam}`
      : row.to_agent_id
        ? 'Conversa atribuída a um agente'
        : row.from_agent_id
          ? 'Atribuição removida'
          : 'Atribuição alterada'
  const it = base(`assignment:${id}`, 'assignment', at, title)
  it.detail = str(row.reason)
  const actor = names.agents.get(String(row.actor_id))
  it.actor = actor ? { name: actor } : null
  it.conversation_id = str(row.conversation_id)
  return it
}

interface PageResult<T> {
  items: T[]
  next_cursor: string | null
}

export async function loadActivity(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  opts: { limit: number; cursor: [string, string] | null; types: ActivityType[] },
): Promise<PageResult<ActivityItem>> {
  const { limit, cursor, types } = opts
  // Cada fonte lê até limit+1 itens anteriores ao cursor; a fusão corta no limite.
  const before = cursor ? new Date(Number(cursor[0]) + 1).toISOString() : null
  const take = limit + 1
  const want = (t: ActivityType) => types.includes(t)

  const { data: convRows, error: convError } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false })
    .limit(CONVERSATION_IDS_MAX)
  if (convError) throw convError
  const convIds = ((convRows ?? []) as Array<{ id: string }>).map((c) => c.id)

  const items: ActivityItem[] = []

  const tasks: Array<Promise<void>> = []
  if (want('message') && convIds.length > 0) {
    tasks.push((async () => {
      let q = db.from('messages').select('id, conversation_id, sender_type, content_type, content_text, created_at').in('conversation_id', convIds)
      if (before) q = q.lt('created_at', before)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(take)
      if (error) throw error
      for (const r of (data ?? []) as Row[]) { const it = messageItem(r); if (it) items.push(it) }
    })())
  }
  if (want('event')) {
    tasks.push((async () => {
      let q = db.from('audit_logs').select('id, event_type, summary, user_name, created_at').eq('account_id', accountId).eq('resource_type', 'contact').eq('resource_id', contactId)
      if (before) q = q.lt('created_at', before)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(take)
      if (error) throw error
      for (const r of (data ?? []) as Row[]) { const it = eventItem(r); if (it) items.push(it) }
    })())
  }
  if (want('note')) {
    tasks.push((async () => {
      let q = db.from('contact_notes').select('id, user_id, note_text, created_at').eq('contact_id', contactId)
      if (before) q = q.lt('created_at', before)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(take)
      if (error) throw error
      const rows = (data ?? []) as Row[]
      const authors = await profileNames(db, rows.map((r) => String(r.user_id)))
      for (const r of rows) { const it = noteItem(r, authors); if (it) items.push(it) }
    })())
  }
  if (want('deal')) {
    tasks.push((async () => {
      const { data, error } = await db.from('deals').select('id, title, stage_id, created_at, updated_at').eq('contact_id', contactId).order('updated_at', { ascending: false }).limit(take)
      if (error) throw error
      const rows = (data ?? []) as Row[]
      const stageIds = [...new Set(rows.map((r) => String(r.stage_id)))]
      const stages = new Map<string, string>()
      if (stageIds.length > 0) {
        const { data: st } = await db.from('pipeline_stages').select('id, name').in('id', stageIds)
        for (const s of (st ?? []) as Row[]) stages.set(String(s.id), String(s.name))
      }
      for (const r of rows) items.push(...dealItems(r, stages.get(String(r.stage_id)) ?? null))
    })())
  }
  if (want('assignment') && convIds.length > 0) {
    tasks.push((async () => {
      let q = db.from('conversation_assignments').select('id, conversation_id, to_agent_id, from_agent_id, to_team_id, actor_id, reason, created_at').eq('account_id', accountId).in('conversation_id', convIds)
      if (before) q = q.lt('created_at', before)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(take)
      if (error) throw error
      const rows = (data ?? []) as Row[]
      const agents = await profileNames(db, rows.flatMap((r) => [r.to_agent_id, r.actor_id]).filter(Boolean).map(String))
      const teamIds = [...new Set(rows.map((r) => r.to_team_id).filter(Boolean).map(String))]
      const teams = new Map<string, string>()
      if (teamIds.length > 0) {
        const { data: t } = await db.from('teams').select('id, name').eq('account_id', accountId).in('id', teamIds)
        for (const x of (t ?? []) as Row[]) teams.set(String(x.id), String(x.name))
      }
      for (const r of rows) { const it = assignmentItem(r, { agents, teams }); if (it) items.push(it) }
    })())
  }
  await Promise.all(tasks)

  const page = items.filter((i) => afterCursor(i, cursor)).sort(compareActivity)
  const cut = page.slice(0, limit)
  const last = cut[cut.length - 1]
  return { items: cut, next_cursor: page.length > limit && last ? encodeCursor([String(ms(last.at)), last.key]) : null }
}

async function profileNames(db: SupabaseClient, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(userIds)].slice(0, 200)
  if (ids.length === 0) return out
  const { data } = await db.from('profiles').select('user_id, full_name').in('user_id', ids)
  for (const p of (data ?? []) as Row[]) out.set(String(p.user_id), String(p.full_name))
  return out
}

export interface CampaignItem {
  id: string
  campaign_id: string | null
  campaign_name: string | null
  campaign_status: string | null
  status: string
  scheduled_at: string | null
  sent_at: string | null
  replied_at: string | null
  error: string | null
  template_name: string | null
}

export async function loadContactCampaigns(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  opts: { limit: number; cursor: [string, string] | null },
): Promise<PageResult<CampaignItem>> {
  const { limit, cursor } = opts
  let q = db
    .from('disp_message_queue')
    .select('id, campaign_id, status, scheduled_at, sent_at, replied_at, erro, template_name')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
  if (cursor) {
    // cursor = [scheduled_at bruto do banco, id]; item sem agendamento não é paginável por este cursor (não ocorre na fila).
    q = q.or(`scheduled_at.lt."${cursor[0]}",and(scheduled_at.eq."${cursor[0]}",id.lt."${cursor[1]}")`)
  }
  const { data, error } = await q.order('scheduled_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
  if (error) throw error
  const rows = (data ?? []) as Row[]
  const pageRows = rows.slice(0, limit)

  const campaignIds = [...new Set(pageRows.map((r) => str(r.campaign_id)).filter((x): x is string => !!x))]
  const campaigns = new Map<string, { nome: string | null; status: string | null }>()
  if (campaignIds.length > 0) {
    const { data: cs, error: cError } = await db.from('campaigns').select('id, nome, status').eq('account_id', accountId).in('id', campaignIds)
    if (cError) throw cError
    for (const c of (cs ?? []) as Row[]) campaigns.set(String(c.id), { nome: str(c.nome), status: str(c.status) })
  }
  const items: CampaignItem[] = pageRows.map((r) => {
    const c = campaigns.get(String(r.campaign_id))
    const status = String(r.status ?? '')
    return {
      id: String(r.id),
      campaign_id: str(r.campaign_id),
      campaign_name: c?.nome ?? null,
      campaign_status: c?.status ?? null,
      status,
      scheduled_at: str(r.scheduled_at),
      sent_at: str(r.sent_at),
      replied_at: str(r.replied_at),
      error: status === 'erro' || status === 'bloqueado' ? str(r.erro) : null,
      template_name: str(r.template_name),
    }
  })
  const last = pageRows[pageRows.length - 1]
  const lastAt = last ? str(last.scheduled_at) : null
  return { items, next_cursor: rows.length > limit && last && lastAt ? encodeCursor([lastAt, String(last.id)]) : null }
}
