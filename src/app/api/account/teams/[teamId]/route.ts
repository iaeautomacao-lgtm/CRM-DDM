import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/account/admin-client'
import { logAuditEvent } from '@/lib/audit/log-event'
import { SLA_RANGE_ERROR, effectiveSlaMinutes, isValidSlaMinutes } from '@/lib/sla/config'
import { loadSlaConfig } from '@/lib/sla/load'

export const dynamic = 'force-dynamic'

// PATCH /api/account/teams/{teamId}  body { first_response_sla_min: int 1..1440 | null }   — teams.manage (admin/owner)
// Meta de primeira resposta da equipe (migration 381). null = usa o padrão da conta. A equipe precisa ser da conta de quem pede (outra conta = 404).
// Auditoria team.sla_changed: id da equipe e valores antes/depois, nada mais.
type Params = { params: Promise<{ teamId: string }> }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEADERS = { 'Cache-Control': 'no-store, private' }
const reply = (error: string, status: number) => NextResponse.json({ error }, { status, headers: HEADERS })
const missingColumn = (e: { code?: string } | null) => e?.code === '42703' || e?.code === 'PGRST204'
const NOT_APPLIED = 'SLA por equipe indisponível: aplique a migration 381'

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requirePermission('teams.manage')
    const { teamId } = await params
    if (!UUID_RE.test(teamId)) return reply('Equipe não encontrada', 404)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('first_response_sla_min' in body)) return reply(SLA_RANGE_ERROR, 400)
    const value = body.first_response_sla_min
    if (value !== null && !isValidSlaMinutes(value)) return reply(SLA_RANGE_ERROR, 400)

    const db = supabaseAdmin()
    const found = await db.from('teams').select('id, first_response_sla_min').eq('id', teamId).eq('account_id', ctx.accountId).limit(1)
    if (found.error) {
      if (missingColumn(found.error)) return reply(NOT_APPLIED, 503)
      console.error('[PATCH /api/account/teams] falha ao ler a equipe:', found.error.code ?? 'erro')
      return reply('Não foi possível salvar o SLA da equipe.', 500)
    }
    const current = ((found.data ?? []) as Array<{ id: string; first_response_sla_min: number | null }>)[0]
    if (!current) return reply('Equipe não encontrada', 404)

    const saved = await db.from('teams').update({ first_response_sla_min: value, updated_at: new Date().toISOString() }).eq('id', teamId).eq('account_id', ctx.accountId).select('id').limit(1)
    if (saved.error) {
      if (missingColumn(saved.error)) return reply(NOT_APPLIED, 503)
      console.error('[PATCH /api/account/teams] falha ao salvar:', saved.error.code ?? 'erro')
      return reply('Não foi possível salvar o SLA da equipe.', 500)
    }
    if (!(saved.data ?? [])[0]) return reply('Equipe não encontrada', 404)

    const before = current.first_response_sla_min ?? null
    if (before !== value) {
      await logAuditEvent({
        accountId: ctx.accountId,
        eventType: 'updated',
        resourceType: 'team',
        resourceId: teamId,
        action: 'team.sla_changed',
        summary: 'SLA da primeira resposta da equipe alterado',
        changes: { first_response_sla_min: { before, after: value } },
      })
    }
    const config = await loadSlaConfig(db, ctx.accountId)
    return NextResponse.json({ team_id: teamId, first_response_sla_min: value, effective_min: effectiveSlaMinutes(config, teamId) }, { headers: HEADERS })
  } catch (err) {
    return toErrorResponse(err)
  }
}
