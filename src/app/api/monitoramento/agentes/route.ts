import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'

// GET /api/monitoramento/agentes?from=ISO&to=ISO   (padrão: últimos 7 dias; janela máxima 92 dias)
// Métricas por atendente no período: tempo médio de 1ª resposta e conversas resolvidas.
//   { from, to, agents: [{ agent_id, first_response_count, first_response_avg_seconds | null, resolved_count }] }
// Agregação na RPC wacrm.monitoring_agent_metrics (migration 300, SECURITY INVOKER: a RLS do usuário vale —
// supervisor vê só as equipes dele). Mesmas definições de "atendidas"/"finalizadas" de /api/monitoramento/dia.
const MAX_DAYS = 92

function parseIso(v: string | null): string | null {
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null
}

export async function GET(request: Request) {
  try {
    const { supabase } = await requirePermission('monitoring.view_team')
    const p = new URL(request.url).searchParams
    const to = parseIso(p.get('to')) ?? new Date().toISOString()
    const from = parseIso(p.get('from')) ?? new Date(Date.parse(to) - 7 * 86_400_000).toISOString()
    if (Date.parse(to) <= Date.parse(from)) {
      return NextResponse.json({ error: 'Período inválido' }, { status: 400 })
    }
    if (Date.parse(to) - Date.parse(from) > MAX_DAYS * 86_400_000) {
      return NextResponse.json({ error: `Período máximo de ${MAX_DAYS} dias` }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('monitoring_agent_metrics', { p_from: from, p_to: to })
    if (error) throw error
    const agents = ((data ?? []) as Array<{
      agent_id: string
      first_response_count: number | string
      first_response_avg_seconds: number | string | null
      resolved_count: number | string
    }>).map((r) => ({
      agent_id: r.agent_id,
      first_response_count: Number(r.first_response_count),
      first_response_avg_seconds: r.first_response_avg_seconds == null ? null : Number(r.first_response_avg_seconds),
      resolved_count: Number(r.resolved_count),
    }))
    return NextResponse.json({ from, to, agents })
  } catch (err) {
    return toErrorResponse(err)
  }
}
