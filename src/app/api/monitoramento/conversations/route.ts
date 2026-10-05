import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

// GET /api/monitoramento/conversations — as conversas por trás de um número
// das abas Hoje e SLA (clicar num KPI ou numa célula da tabela).
//   ?metric=received|attended|closed|open|queued
//   &from=ISO&to=ISO        (período; open/queued ignoram: são "agora")
//   &dim=agent|team|channel  &key=<id | 'none' | canal>
//   &page=1
// Mesmas definições de src/lib/monitoramento/day-view.ts e sla.ts.
// Cliente com a sessão do usuário (RLS de conversations).

const PAGE = 50
const METRICS = ['received', 'attended', 'closed', 'open', 'queued'] as const
type Metric = (typeof METRICS)[number]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function iso(v: string | null): string | null {
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('supervisor')
    const p = new URL(request.url).searchParams
    const metric = p.get('metric') as Metric | null
    if (!metric || !METRICS.includes(metric)) {
      return NextResponse.json({ error: 'metric inválida' }, { status: 400 })
    }
    const from = iso(p.get('from'))
    const to = iso(p.get('to'))
    const dim = p.get('dim')
    const key = p.get('key')
    const page = Math.max(1, parseInt(p.get('page') ?? '1', 10) || 1)

    let q = supabase
      .from('conversations')
      .select(
        'id, status, channel_type, assigned_agent_id, team_id, created_at, first_response_at, closed_at, last_customer_message_at, contact:contacts!contact_id(name, phone)',
        { count: 'exact' },
      )
      .eq('account_id', accountId)

    const column = { received: 'created_at', attended: 'first_response_at', closed: 'closed_at' } as const
    if (metric === 'open') q = q.neq('status', 'closed')
    else if (metric === 'queued') q = q.neq('status', 'closed').is('assigned_agent_id', null)
    else {
      if (!from || !to) return NextResponse.json({ error: 'Informe from e to' }, { status: 400 })
      q = q.gte(column[metric], from).lt(column[metric], to)
    }

    if (dim === 'agent' || dim === 'team') {
      const col = dim === 'agent' ? 'assigned_agent_id' : 'team_id'
      if (key === 'none') q = q.is(col, null)
      else if (key && UUID_RE.test(key)) q = q.eq(col, key)
    } else if (dim === 'channel' && key && /^[a-z]{2,20}$/.test(key)) {
      // Conversas antigas sem channel_type são WhatsApp (default da 127).
      q = key === 'whatsapp' ? q.or('channel_type.eq.whatsapp,channel_type.is.null') : q.eq('channel_type', key)
    }

    // Fila: quem espera há mais tempo primeiro; demais: mais recentes.
    q =
      metric === 'queued'
        ? q.order('last_customer_message_at', { ascending: true, nullsFirst: false })
        : q.order(metric === 'open' ? 'created_at' : column[metric], { ascending: false })
    q = q.order('id', { ascending: false })

    const fromRow = (page - 1) * PAGE
    const { data, error, count } = await q.range(fromRow, fromRow + PAGE - 1)
    if (error) throw error

    const agentIds = [...new Set((data ?? []).map((c) => c.assigned_agent_id).filter(Boolean))] as string[]
    const names = new Map<string, string>()
    if (agentIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', accountId)
        .in('user_id', agentIds)
      for (const pr of profiles ?? []) names.set(pr.user_id, pr.full_name)
    }

    const rows = (data ?? []).map((c) => {
      const contact = Array.isArray(c.contact) ? c.contact[0] : c.contact
      return {
        id: c.id,
        contact_name: contact?.name || contact?.phone || 'Contato',
        phone: contact?.phone ?? null,
        status: c.status,
        channel_type: c.channel_type ?? 'whatsapp',
        agent_name: c.assigned_agent_id ? names.get(c.assigned_agent_id) ?? 'Atendente' : null,
        created_at: c.created_at,
        first_response_min: c.first_response_at
          ? Math.max(0, Math.round((Date.parse(c.first_response_at) - Date.parse(c.created_at)) / 60_000))
          : null,
        waiting_min:
          c.status !== 'closed' && !c.assigned_agent_id && c.last_customer_message_at
            ? Math.max(0, Math.round((Date.now() - Date.parse(c.last_customer_message_at)) / 60_000))
            : null,
        closed_at: c.closed_at,
      }
    })
    return NextResponse.json({ rows, total: count ?? 0, page, pageSize: PAGE })
  } catch (err) {
    return toErrorResponse(err)
  }
}
