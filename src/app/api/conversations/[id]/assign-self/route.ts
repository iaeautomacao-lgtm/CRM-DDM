import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// POST /api/conversations/[id]/assign-self   (PRD 24, item 1 — "Assumir" / abas Minhas · Fila · Todas)
//
// O atendente assume uma conversa que está SEM atendente (a fila). Regras:
//   - permissão inbox.reply + a conversa precisa estar VISÍVEL para ele (leitura com o cliente dele, RLS de conversations: o agente só enxerga
//     as dele e a fila da(s) equipe(s) dele; admin/supervisor enxergam as da conta);
//   - só assume se NÃO houver atendente (conversa de outra pessoa se transfere pela rota de transferência) e não estiver encerrada;
//   - ATÔMICO: um único UPDATE com a condição assigned_agent_id IS NULL — dois atendentes clicando "Assumir" ao mesmo tempo: um ganha (200),
//     o outro recebe 409 already_assigned; assumir de novo a que já é sua é idempotente (200, already_mine).
// A escrita vai pelo service role (a RLS do agente também valida a linha nova no UPDATE ... RETURNING); o histórico de atribuição vem do
// trigger log_conversation_assignment, e aqui completamos o ator. A mensagem de "assumi o atendimento" ao cliente continua no cliente
// (sendTakeoverMessage), igual à atribuição pelo dropdown — texto voltado ao cliente não nasce no servidor.
//
// Abas do Inbox (sem rota nova): Minhas = ?atendente=me · Fila = ?atendente=unassigned · Todas = sem o filtro; o canal (?canal=) combina com qualquer uma.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requirePermission('inbox.reply')
    const { id: conversationId } = await params
    if (!UUID_RE.test(conversationId)) return NextResponse.json({ error: 'Conversa inválida' }, { status: 400 })

    // Visibilidade pela RLS do próprio usuário (404 também para conversa de outra equipe/conta — não revela que existe).
    const { data: visible, error: visErr } = await supabase
      .from('conversations')
      .select('id, status, assigned_agent_id, team_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .limit(1)
    if (visErr) throw visErr
    const current = visible?.[0]
    if (!current) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })

    if (current.assigned_agent_id === userId) {
      return NextResponse.json({ conversation: current, already_mine: true })
    }
    if (current.status === 'closed') {
      return NextResponse.json({ error: 'A conversa está encerrada', code: 'conversation_closed' }, { status: 409 })
    }
    if (current.assigned_agent_id) {
      return NextResponse.json({ error: 'A conversa já tem outro atendente', code: 'already_assigned' }, { status: 409 })
    }

    const db = supabaseAdmin()
    const startedAt = new Date().toISOString()
    const { data: updated, error } = await db
      .from('conversations')
      .update({ assigned_agent_id: userId })
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .is('assigned_agent_id', null)
      .neq('status', 'closed')
      .select('id, status, assigned_agent_id, team_id')
    if (error) throw error
    const conversation = updated?.[0]
    if (!conversation) {
      // Perdeu a corrida (ou a conversa foi encerrada/atribuída entre a leitura e o UPDATE): diz quem ficou com ela.
      const { data: now } = await db
        .from('conversations')
        .select('id, status, assigned_agent_id, team_id')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .limit(1)
      const latest = now?.[0]
      if (latest?.assigned_agent_id === userId) return NextResponse.json({ conversation: latest, already_mine: true })
      if (latest?.status === 'closed') {
        return NextResponse.json({ error: 'A conversa está encerrada', code: 'conversation_closed' }, { status: 409 })
      }
      return NextResponse.json({ error: 'A conversa já tem outro atendente', code: 'already_assigned' }, { status: 409 })
    }

    // Completa o ator na linha de histórico que o trigger acabou de gravar (actor_id nulo sob service role).
    const { data: rows } = await db
      .from('conversation_assignments')
      .select('id')
      .eq('conversation_id', conversationId)
      .is('actor_id', null)
      .gte('created_at', startedAt)
      .order('created_at', { ascending: false })
      .limit(1)
    const row = rows?.[0]
    if (row) await db.from('conversation_assignments').update({ actor_id: userId, reason: 'Assumiu a conversa' }).eq('id', row.id)

    return NextResponse.json({ conversation, already_mine: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
