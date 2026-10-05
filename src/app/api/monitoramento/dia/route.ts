import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  computeDayView,
  dayBounds,
  isValidDay,
  todayInBrazil,
  type DayConversationRow,
} from '@/lib/monitoramento/day-view'

// GET /api/monitoramento/dia?date=YYYY-MM-DD — aba "Hoje" do Monitoramento
// (owner/admin, como a página). Busca as conversas que tocam o dia
// (criadas, atendidas ou finalizadas nele) e, se for hoje, também as
// abertas agora. Agregação em src/lib/monitoramento/day-view.ts.
// Requer migrations 128 (first_response_at) e 130 (closed_at).

const PAGE = 1000
const MAX_ROWS = 20_000
const COLUMNS =
  'channel_type, team_id, assigned_agent_id, status, created_at, first_response_at, closed_at'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('supervisor')
    const param = new URL(request.url).searchParams.get('date')
    const today = todayInBrazil()
    const date = isValidDay(param) ? param : today
    const isToday = date === today
    const { startMs, endMs } = dayBounds(date)
    const start = new Date(startMs).toISOString()
    const end = new Date(endMs).toISOString()

    const touches = [
      `and(created_at.gte.${start},created_at.lt.${end})`,
      `and(first_response_at.gte.${start},first_response_at.lt.${end})`,
      `and(closed_at.gte.${start},closed_at.lt.${end})`,
      ...(isToday ? ['status.neq.closed'] : []),
    ].join(',')

    const rows: DayConversationRow[] = []
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await supabase
        .from('conversations')
        .select(COLUMNS)
        .eq('account_id', accountId)
        .or(touches)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) throw error
      rows.push(...((data ?? []) as DayConversationRow[]))
      if (!data || data.length < PAGE) break
    }

    // Transferências do dia (histórico da migration 128).
    const { count: transfers } = await supabase
      .from('conversation_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .gte('created_at', start)
      .lt('created_at', end)
      .not('from_agent_id', 'is', null)

    return NextResponse.json({
      ...computeDayView(rows, date, isToday),
      is_today: isToday,
      transfers: transfers ?? 0,
      truncated: rows.length >= MAX_ROWS,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
