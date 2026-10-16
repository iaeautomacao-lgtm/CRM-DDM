import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { loadRequestedAgents } from '@/lib/inbox/requested-agent'

// GET /api/conversations/[id]/reservation — para quem a conversa está reservada ("Aguardando @fulano", migration 376).
// A conversa é lida com a sessão do usuário: a RLS (a 376 inclusa) decide quem a enxerga, e quem não pode vê-la recebe 404,
// igual a uma conversa inexistente. O nome/apelido do operador vem do service role, filtrado pela conta; só user_id,
// full_name e mention_alias saem.
// Sem a migration 376 (coluna ausente) a resposta é "sem reserva".

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })

    const { data, error } = await supabase
      .from('conversations')
      .select('id, requested_agent_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .limit(1)
    if (error) {
      if (error.code === '42703' || error.code === 'PGRST204') {
        return NextResponse.json({ requested_agent_id: null, requested_agent: null })
      }
      throw error
    }
    const conv = (data ?? [])[0] as { id: string; requested_agent_id?: string | null } | undefined
    if (!conv) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })

    const requestedId = conv.requested_agent_id ?? null
    const agent = requestedId ? ((await loadRequestedAgents(accountId, [requestedId])).get(requestedId) ?? null) : null
    return NextResponse.json({ requested_agent_id: requestedId, requested_agent: agent })
  } catch (err) {
    return toErrorResponse(err)
  }
}
