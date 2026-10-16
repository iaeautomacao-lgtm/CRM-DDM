import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/account/admin-client'
import { SLA_FALLBACK_MINUTES, effectiveByTeam } from '@/lib/sla/config'
import { loadSlaConfig } from '@/lib/sla/load'

export const dynamic = 'force-dynamic'

// GET /api/sla/config — meta de primeira resposta (SLA) da conta e de cada equipe, numa leitura barata para o Inbox, o Monitoramento e os alertas.
// Qualquer membro lê (account.view; só minutos e ids de equipe, nada sensível). Sempre escopado pela conta de quem pede.
//   default_min     padrão efetivo da conta (15 quando não configurado)      default_source  'account' | 'default'
//   teams           { team_id: minutos próprios | null (usa o padrão) }      effective       { team_id: minutos já resolvidos }
// Sem a migration 381 (coluna) ou a 231 (configurações): tudo vale o padrão (teams e effective vazios).
export async function GET() {
  try {
    const ctx = await requirePermission('account.view')
    const config = await loadSlaConfig(supabaseAdmin(), ctx.accountId)
    return NextResponse.json(
      { default_min: config.defaultMin, default_source: config.defaultSource, fallback_min: SLA_FALLBACK_MINUTES, teams: config.teams, effective: effectiveByTeam(config) },
      { headers: { 'Cache-Control': 'no-store, private' } },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
