import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { logAuditEvent } from '@/lib/audit/log-event'
import {
  actionLabel,
  actorLabel,
  displayValue,
  fieldLabel,
  RESOURCE_LABEL,
  type AuditLog,
} from '@/lib/audit/labels'

// GET /api/audit-logs — tela /relatorios/auditoria (owner/admin).
//   ?from=ISO&to=ISO&user=&event=&resource=&action=&actor=&q=&page=&pageSize=
//   ?resource_id=<uuid>      histórico completo de um recurso (modal)
//   ?export=xlsx             exporta o filtro atual (até 10.000 linhas)
// Cliente com a sessão do usuário: a RLS de audit_logs (migration 131) já
// restringe a owner/admin da própria conta.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const EXPORT_MAX = 10_000
const EXPORT_PAGE = 1000

function isoOrNull(v: string | null): string | null {
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const p = new URL(request.url).searchParams

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- builder do PostgREST sem tipos gerados
    const applyFilters = (q: any) => {
      let query = q.eq('account_id', accountId)
      const resourceId = p.get('resource_id')
      if (resourceId && UUID_RE.test(resourceId)) return query.eq('resource_id', resourceId)

      const from = isoOrNull(p.get('from'))
      const to = isoOrNull(p.get('to'))
      if (from) query = query.gte('created_at', from)
      if (to) query = query.lte('created_at', to)
      const user = p.get('user')
      if (user && UUID_RE.test(user)) query = query.eq('user_id', user)
      const event = p.get('event')
      if (event && ['created', 'updated', 'deleted', 'action'].includes(event)) query = query.eq('event_type', event)
      const resource = p.get('resource')
      if (resource && /^[a-z_]{1,40}$/.test(resource)) query = query.eq('resource_type', resource)
      const action = p.get('action')
      if (action && /^[a-z_.]{1,60}$/.test(action)) query = query.eq('action', action)
      const actor = p.get('actor')
      if (actor && /^[a-z]{1,20}$/.test(actor)) {
        // Registros antigos (antes da 131) não têm actor_type: sem usuário = sistema.
        query = actor === 'system'
          ? query.or('actor_type.eq.system,and(actor_type.is.null,user_id.is.null)')
          : query.eq('actor_type', actor)
      }
      const q2 = (p.get('q') ?? '').trim()
      if (q2) {
        if (UUID_RE.test(q2)) query = query.eq('resource_id', q2)
        else {
          // Sem vírgula/parênteses/curingas: gramática do filtro .or().
          const safe = q2.replace(/[,()%*"\\]/g, ' ').trim().slice(0, 80)
          if (safe) {
            query = query.or(
              `resource_label.ilike.%${safe}%,summary.ilike.%${safe}%,user_name.ilike.%${safe}%,ip_address.ilike.%${safe}%`
            )
          }
        }
      }
      return query
    }

    if (p.get('export') === 'xlsx') {
      const rows: AuditLog[] = []
      for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
        const { data, error } = await applyFilters(supabase.from('audit_logs').select('*'))
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + EXPORT_PAGE - 1)
        if (error) throw error
        rows.push(...((data ?? []) as AuditLog[]))
        if (!data || data.length < EXPORT_PAGE) break
      }

      await logAuditEvent({
        accountId,
        eventType: 'action',
        resourceType: 'audit',
        resourceId: accountId,
        resourceLabel: 'Auditoria',
        action: 'audit.exported',
        summary: `Exportou ${rows.length} registro(s) da auditoria`,
        metadata: Object.fromEntries([...p.entries()].filter(([k]) => k !== 'export')),
      })

      const sheet = XLSX.utils.json_to_sheet(
        rows.map((r) => ({
          'Data/hora': new Date(r.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
          Ação: actionLabel(r),
          Resumo: r.summary ?? '',
          Recurso: RESOURCE_LABEL[r.resource_type] ?? r.resource_type,
          'Nome do recurso': r.resource_label ?? '',
          'ID do recurso': r.resource_id,
          Quem: actorLabel(r),
          'Tipo de autor': r.actor_type ?? (r.user_id ? 'user' : 'system'),
          IP: r.ip_address ?? '',
          Origem: r.source ?? '',
          Navegador: r.user_agent ?? '',
          Alterações: r.changes
            ? Object.entries(r.changes)
                .map(([f, c]) => `${fieldLabel(f)}: ${displayValue(c.before)} → ${displayValue(c.after)}`)
                .join(' | ')
            : '',
          Detalhes: r.metadata ? JSON.stringify(r.metadata) : '',
        }))
      )
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Auditoria')
      const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="auditoria-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        },
      })
    }

    const page = Math.max(1, parseInt(p.get('page') ?? '1', 10) || 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(p.get('pageSize') ?? '', 10) || DEFAULT_PAGE_SIZE))
    const fromRow = (page - 1) * pageSize
    const { data, error, count } = await applyFilters(
      supabase.from('audit_logs').select('*', { count: 'exact' })
    )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(fromRow, fromRow + pageSize - 1)
    if (error) throw error
    return NextResponse.json({ logs: data ?? [], total: count ?? 0, page, pageSize })
  } catch (err) {
    return toErrorResponse(err)
  }
}
