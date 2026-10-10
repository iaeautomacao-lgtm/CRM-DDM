import { trackCron } from "@/lib/ops/cron-heartbeat"
import { NextResponse } from 'next/server'
import { registerAuditActor } from '@/lib/audit/context'
import { matchesOperationalSecret } from '@/lib/auth/operational-secret'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * Migration 317 (auditoria B-07): o claim é a RPC claim_automation_pending — uma linha por vez,
 * FOR UPDATE SKIP LOCKED (execuções sobrepostas nunca pegam a mesma linha), com lease. Ela também
 * fecha como 'failed' a linha 'running' de lease vencido (restart no meio): não fica 'running' para
 * sempre e NÃO é retomada (repetiria envios). Orçamento de tempo por chamada; sem a 317, o caminho
 * antigo (claim em dois passos por UPDATE).
 */
const LEASE_SECONDS = 300
const MAX_PER_RUN = 50
const BUDGET_MS = 45_000

type PendingRow = Record<string, unknown> & { id: string }

function toPending(row: PendingRow) {
  return {
    id: row.id,
    automation_id: row.automation_id as string,
    // account_id is NOT NULL on automation_pending_executions
    // post-017; the engine uses it for tenant-scoped lookups.
    account_id: row.account_id as string,
    user_id: row.user_id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    log_id: (row.log_id as string | null) ?? null,
    parent_step_id: (row.parent_step_id as string | null) ?? null,
    branch: (row.branch as 'yes' | 'no' | null) ?? null,
    next_step_position: row.next_step_position as number,
    context: (row.context as AutomationContext) ?? {},
  }
}

async function handler(request: Request) {
  // Auditoria: escritas desta requisição saem como "automation" (cron_automacoes).
  await registerAuditActor({ actorType: 'automation', source: 'cron_automacoes' })
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Comparação em tempo constante (mesmo helper das demais rotas operacionais).
  if (!matchesOperationalSecret(expected, request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const startedAt = Date.now()
  let processed = 0
  let reaped = 0
  for (let i = 0; i < MAX_PER_RUN && Date.now() - startedAt < BUDGET_MS; i++) {
    const { data, error } = await admin.rpc('claim_automation_pending', { p_lease_seconds: LEASE_SECONDS })
    if (error) {
      if (i === 0 && (error.code === '42883' || error.code === 'PGRST202')) return legacyDrain(admin)
      console.error('[automations/cron] claim failed:', error.message)
      return NextResponse.json({ error: 'Falha ao reivindicar execuções pendentes.' }, { status: 500 })
    }
    const result = (Array.isArray(data) ? data[0] : data) as { claimed: PendingRow | null; reaped: number } | null
    reaped += result?.reaped ?? 0
    if (!result?.claimed) break
    await resumePendingExecution(toPending(result.claimed))
    processed++
  }
  if (reaped > 0) console.warn(`[automations/cron] ${reaped} execução(ões) interrompida(s) fechada(s) como falha (lease vencido)`)
  return NextResponse.json({ processed, reaped })
}

/** Caminho antigo (banco sem a migration 317): claim em dois passos, sem lease. */
async function legacyDrain(admin: ReturnType<typeof supabaseAdmin>) {
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[automations/cron] query failed:', error.message)
    return NextResponse.json({ error: 'Falha ao ler execuções pendentes.' }, { status: 500 })
  }
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution(toPending(row as PendingRow))
    processed++
  }

  return NextResponse.json({ processed })
}


// Execução só via POST (crontab do cPanel). GET virou apenas diagnóstico
// para os pingers/health checks existentes: confere o segredo e se a
// tabela responde, sem executar automações pendentes.
export const POST = (request: Request) => trackCron("automations", () => handler(request))
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected)
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  if (!matchesOperationalSecret(expected, request.headers.get('x-cron-secret')))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { error } = await supabaseAdmin().from('automation_pending_executions').select('id').limit(1);
  return NextResponse.json({ status: error ? 'unavailable' : 'healthy' }, { status: error ? 503 : 200 });
}
