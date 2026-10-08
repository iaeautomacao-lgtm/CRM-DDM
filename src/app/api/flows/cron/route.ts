import { timingSafeEqual } from 'node:crypto'
import { registerAuditActor } from '@/lib/audit/context'
import { NextResponse } from 'next/server'
import { matchesOperationalSecret } from '@/lib/auth/operational-secret'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { wakeDelayedRuns } from '@/lib/flows/wake-runs'
import { sweepStalledAiConversations } from '@/lib/flows/ai-watchdog'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
export async function POST(request: Request) {
  // Auditoria: escritas desta requisição saem como "flow" (cron_fluxos).
  await registerAuditActor({ actorType: 'flow', source: 'cron_fluxos' })
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const now = new Date()

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  const { data: runs, error } = await admin.rpc('sweepable_flow_runs', { p_limit: 200 })

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  type Row = {
    id: string
    flow_id: string
    user_id: string
    contact_id: string | null
    last_advanced_at: string
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
  }

  let swept = 0
  for (const r of (runs ?? []) as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) continue

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update.
    const { data: updated } = await admin
      .from('flow_runs')
      .update({
        status: 'timed_out',
        ended_at: now.toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id')

    if (Array.isArray(updated) && updated.length > 0) {
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
        },
      })
      swept += 1
    }
  }

  // ------------------------------------------------------------
  // Wake smart_delay runs whose wait has elapsed (src/lib/flows/wake-runs.ts):
  // ordem wake_at, run inconsistente encerrado de forma controlada (nunca
  // fica `active` preso) e falha de um run isolada dos demais. Lote do
  // caminho padrão: 20; com FLOWS_CRON_V2 (migration 210) o lote é
  // configurável (?batch=, padrão 50) e repete até esvaziar ou 30 s.
  // ------------------------------------------------------------
  const batchParam = Number.parseInt(new URL(request.url).searchParams.get('batch') ?? '', 10)
  const { woken, failed, skipped } = await wakeDelayedRuns(admin, {
    now,
    batch: Number.isFinite(batchParam) ? batchParam : undefined,
  })

  // IA travada: cliente falou por último, fluxo ativo e ninguém respondeu
  // há mais de AI_STALL_SECONDS (padrão 180 s) → fila humana (ver ai-watchdog.ts).
  const stalled = await sweepStalledAiConversations(admin, now)

  return NextResponse.json({ swept, woken, failed, skipped, stalled })
}

// GET = só diagnóstico (health check): confere o segredo e se a tabela
// flow_runs responde. NÃO executa o sweep — a execução é só via POST,
// para monitores e pingers não dispararem automações.
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected)
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  // Comparação em tempo constante, como no POST acima.
  if (!matchesOperationalSecret(expected, request.headers.get('x-cron-secret')))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { error } = await supabaseAdmin().from('flow_runs').select('id').limit(1);
  return NextResponse.json({ status: error ? 'unavailable' : 'healthy' }, { status: error ? 503 : 200 });
}
