import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { computeSla, SLA_TARGET_MINUTES, type SlaConversationRow } from '@/lib/monitoramento/sla'

// GET /api/monitoramento/sla?days=7 — painel de SLA (owner/admin, como
// /monitoramento). Conversas criadas no período + todas ainda abertas
// (para a fila atual), paginadas com .range(). Agregação em
// src/lib/monitoramento/sla.ts.

const PAGE = 1000
const MAX_ROWS = 20_000
const COLUMNS =
  'channel_type, team_id, status, assigned_agent_id, created_at, first_response_at, last_customer_message_at'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requirePermission('monitoring.view_team')
    const daysParam = Number(new URL(request.url).searchParams.get('days') ?? 7)
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(Math.trunc(daysParam), 1), 90) : 7
    const nowMs = Date.now()
    const sinceMs = nowMs - days * 86_400_000
    const since = new Date(sinceMs).toISOString()

    const rows: SlaConversationRow[] = []
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await supabase
        .from('conversations')
        .select(COLUMNS)
        .eq('account_id', accountId)
        .or(`created_at.gte.${since},status.neq.closed`)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) throw error
      rows.push(...((data ?? []) as SlaConversationRow[]))
      if (!data || data.length < PAGE) break
    }

    return NextResponse.json({
      days,
      target_minutes: SLA_TARGET_MINUTES,
      truncated: rows.length >= MAX_ROWS,
      ...computeSla(rows, { sinceMs, nowMs }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
