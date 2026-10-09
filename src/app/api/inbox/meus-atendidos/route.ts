import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// GET /api/inbox/meus-atendidos?cursor=<ISO>|<uuid>&days=90   (PRD 23, item 17 — opcional "Meus atendidos")
//
// Conversas que o operador ATENDEU e TRANSFERIU (conversation_assignments.from_agent_id = ele; hoje com outro atendente ou sem),
// da mais recente transferência para a mais antiga; 50 por página. A RLS de conversations esconde do agente a conversa que saiu dele,
// então: a RPC wacrm.inbox_my_handled (migration 302, SECURITY DEFINER, só o histórico do próprio usuário e da conta dele) devolve os ids
// e a leitura das linhas vai pelo service role, com o escopo da conta e só colunas de listagem (contato: id, nome, telefone — sem CPF etc.).
// É LISTA SOMENTE LEITURA: o operador não ganha acesso à conversa/mensagens (continuam pela RLS). Quem está com ela hoje vem em
// `transferred_to`.
//   { conversations: [{ ...conversa, contact, outcome_tag, transferred_at, transfer_reason, transferred_to: {id, full_name}|null,
//                       transferred_to_team_id }], next_cursor }
const PAGE_SIZE = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLUMNS =
  'id, account_id, channel_type, status, assigned_agent_id, team_id, last_message_at, last_message_text, unread_count, outcome_tag_id, closed_at, ' +
  'contact:contacts(id, name, phone), outcome_tag:tags!outcome_tag_id(id, name, color)'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requirePermission('inbox.view')
    const params = new URL(request.url).searchParams
    const days = Math.min(Math.max(parseInt(params.get('days') ?? '90', 10) || 90, 1), 365)

    let before: string | null = null
    let beforeId: string | null = null
    const cursor = params.get('cursor')
    if (cursor) {
      const [at, id] = cursor.split('|')
      if (at && id && !Number.isNaN(Date.parse(at)) && UUID_RE.test(id)) {
        before = new Date(at).toISOString()
        beforeId = id
      }
    }

    const { data: handled, error } = await supabase.rpc('inbox_my_handled', {
      p_before: before,
      p_before_id: beforeId,
      p_limit: PAGE_SIZE + 1,
      p_days: days,
    })
    if (error) throw error
    const rows = (handled ?? []) as Array<{
      conversation_id: string
      transferred_at: string
      to_agent_id: string | null
      to_team_id: string | null
      reason: string | null
    }>
    const hasMore = rows.length > PAGE_SIZE
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows
    if (page.length === 0) return NextResponse.json({ conversations: [], next_cursor: null })

    const db = supabaseAdmin()
    const { data: convs, error: convErr } = await db
      .from('conversations')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .in('id', page.map((r) => r.conversation_id))
    if (convErr) throw convErr
    const byId = new Map(((convs ?? []) as unknown as Array<{ id: string }>).map((c) => [c.id, c]))

    const agentIds = [...new Set(page.map((r) => r.to_agent_id).filter((v): v is string => !!v))]
    const names = new Map<string, string | null>()
    if (agentIds.length > 0) {
      const { data: profiles, error: profErr } = await db
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', accountId)
        .in('user_id', agentIds)
      if (profErr) throw profErr
      for (const p of (profiles ?? []) as Array<{ user_id: string; full_name: string | null }>) names.set(p.user_id, p.full_name)
    }

    const conversations = page.flatMap((r) => {
      const conv = byId.get(r.conversation_id)
      if (!conv) return []
      return [
        {
          ...conv,
          transferred_at: r.transferred_at,
          transfer_reason: r.reason,
          transferred_to: r.to_agent_id ? { id: r.to_agent_id, full_name: names.get(r.to_agent_id) ?? null } : null,
          transferred_to_team_id: r.to_team_id,
        },
      ]
    })
    const last = page[page.length - 1]
    return NextResponse.json({
      conversations,
      next_cursor: hasMore ? `${last.transferred_at}|${last.conversation_id}` : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
