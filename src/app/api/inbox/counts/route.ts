import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { INBOX_CHANNELS, parseInboxFilters } from '@/lib/inbox/filters'
import { applyInboxFilters, resolveLineClause } from '@/lib/inbox/query'

// GET /api/inbox/counts — números das abas de canal: conversas com
// mensagem não lida (não fechadas) por canal, com os MESMOS filtros da
// lista (linha, atendente, equipe, cliente, campanha), menos o canal.
// RLS do usuário, como a lista.

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    const filters = parseInboxFilters(new URL(request.url).searchParams)
    const line = await resolveLineClause(supabase, accountId, filters.linha)

    const counts = await Promise.all(
      [null, ...INBOX_CHANNELS].map(async (channel) => {
        const query = applyInboxFilters(
          supabase
            .from('conversations')
            .select('id', { count: 'exact', head: true })
            .gt('unread_count', 0)
            .neq('status', 'closed'),
          { ...filters, canal: channel },
          { accountId, userId, line },
          { includeStatus: false }
        )
        const { count, error } = await query
        if (error) throw error
        return [channel ?? 'all', count ?? 0] as const
      })
    )

    // Totais por fila operacional. A classificação usa atribuição humana:
    // com assigned_agent_id = Em atendimento; sem atendente = Em espera.
    const statusTotals = await Promise.all(
      ([
        ['open', true],
        ['pending', false],
      ] as const).map(async ([statusKey, assigned]) => {
        let query = applyInboxFilters(
          supabase
            .from('conversations')
            .select('id', { count: 'exact', head: true })
            .in('status', ['open', 'pending']),
          filters,
          { accountId, userId, line },
          { includeStatus: false }
        )
        query = assigned
          ? query.not('assigned_agent_id', 'is', null)
          : query.is('assigned_agent_id', null)
        const { count, error } = await query
        // Total da seção é complemento: se falhar, devolve null e a UI usa
        // a contagem carregada — nunca derruba os contadores de não lidas.
        if (error) {
          console.error('[inbox/counts] total por fila falhou:', error.message)
          return [statusKey, null] as const
        }
        return [statusKey, count ?? 0] as const
      })
    )
    return NextResponse.json({ unread: Object.fromEntries(counts), status: Object.fromEntries(statusTotals) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
