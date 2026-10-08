import { NextResponse } from 'next/server'
import { registerAuditActor } from '@/lib/audit/context'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// POST /api/conversations/[id]/transfer  { agent_id?, team_id?, reason? }
//
// Transfere a conversa para outro atendente e/ou equipe num único UPDATE.
// Permissão: o usuário precisa ENXERGAR a conversa (leitura com o cliente
// dele, RLS de conversations). A escrita vai pelo service role porque a
// RLS do agente (migration 128) também valida a linha nova no UPDATE ...
// RETURNING — transferir para outro atendente tiraria a conversa da visão
// dele e o UPDATE falharia. O trigger log_conversation_assignment grava o
// histórico (com actor_id null sob service role); aqui completamos ator e
// motivo nessa linha.
//
// `agent_id`/`team_id` ausentes = não mexer; null = remover.
// A mensagem de "assumi o atendimento" ao cliente continua no cliente
// (sendTakeoverMessage), igual à atribuição pelo dropdown.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REASON_MAX = 500

function parseTarget(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  return typeof v === 'string' && UUID_RE.test(v) ? v : undefined
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requirePermission('inbox.transfer')
    const { id: conversationId } = await params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const agentId = parseTarget(body.agent_id)
    const teamId = parseTarget(body.team_id)
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, REASON_MAX) : ''
    if (agentId === undefined && teamId === undefined) {
      return NextResponse.json({ error: 'Informe agent_id e/ou team_id' }, { status: 400 })
    }

    // Destino precisa ser da mesma conta.
    if (agentId) {
      const { data } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('user_id', agentId)
        .eq('account_id', accountId)
        .limit(1)
      if (!data?.[0]) return NextResponse.json({ error: 'Atendente inválido' }, { status: 400 })
    }
    if (teamId) {
      const { data } = await supabase
        .from('teams')
        .select('id')
        .eq('id', teamId)
        .eq('account_id', accountId)
        .limit(1)
      if (!data?.[0]) return NextResponse.json({ error: 'Equipe inválida' }, { status: 400 })
    }

    const patch: Record<string, string | null> = {}
    if (agentId !== undefined) patch.assigned_agent_id = agentId
    if (teamId !== undefined) patch.team_id = teamId

    const { data: visible, error: visErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .limit(1)
    if (visErr) throw visErr
    if (!visible?.[0]) {
      return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    }

    // O motivo entra no registro de auditoria da trigger (migration 131).
    if (reason) await registerAuditActor({ note: reason })
    const db = supabaseAdmin()
    const startedAt = new Date().toISOString()
    const { data: updated, error } = await db
      .from('conversations')
      .update(patch)
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .select('id, assigned_agent_id, team_id')
    if (error) throw error
    const conversation = updated?.[0]
    if (!conversation) {
      return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    }

    // A linha que o trigger acabou de gravar (se algo mudou de fato).
    const { data: rows } = await db
      .from('conversation_assignments')
      .select('id')
      .eq('conversation_id', conversationId)
      .is('actor_id', null)
      .gte('created_at', startedAt)
      .order('created_at', { ascending: false })
      .limit(1)
    const row = rows?.[0]
    if (row) {
      await db
        .from('conversation_assignments')
        .update({ actor_id: userId, ...(reason ? { reason } : {}) })
        .eq('id', row.id)
    }

    return NextResponse.json({ conversation })
  } catch (err) {
    return toErrorResponse(err)
  }
}
