import { timingSafeEqual } from 'node:crypto'
import { registerAuditActor } from '@/lib/audit/context'
import { NextResponse } from 'next/server'
import { matchesOperationalSecret } from '@/lib/auth/operational-secret'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { advanceFromNodeKey, loadAllNodes } from '@/lib/flows/engine'
import type { FlowRunRow, SmartDelayNodeConfig } from '@/lib/flows/types'

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
  // Wake smart_delay runs whose wait has elapsed. Bounded to 20 per
  // sweep (same cadence as the timeout sweep above) — a run that
  // misses this tick just gets picked up on the next one, a few
  // minutes late at worst.
  // ------------------------------------------------------------
  const { data: delayedRuns, error: delayedErr } = await admin
    .from('flow_runs')
    .select('*')
    .eq('status', 'delayed')
    .lte('wake_at', now.toISOString())
    .limit(20)

  if (delayedErr) {
    console.error('[flows-cron] delayed-run scan failed:', delayedErr.message)
  }

  let woken = 0
  for (const run of (delayedRuns ?? []) as FlowRunRow[]) {
    // Optimistic guard: only the sweep that actually flips
    // status='delayed' → 'active' gets to resume the run — protects
    // against two overlapping cron invocations waking the same run
    // twice.
    const { data: claimed } = await admin
      .from('flow_runs')
      .update({ status: 'active', wake_at: null })
      .eq('id', run.id)
      .eq('status', 'delayed')
      .select('id')
    if (!Array.isArray(claimed) || claimed.length === 0) continue

    if (!run.current_node_key) {
      console.error(`[flows-cron] delayed run ${run.id} has no current_node_key`)
      continue
    }
    const nodes = await loadAllNodes(admin, run.flow_id)
    // The run suspended AT the smart_delay node itself (same pattern
    // as collect_input/send_buttons/send_list) — resume from ITS
    // next_node_key, not by re-entering smart_delay (which would just
    // re-send the message and re-suspend forever).
    const delayNode = nodes.get(run.current_node_key)
    const nextKey = delayNode
      ? (delayNode.config as unknown as SmartDelayNodeConfig).next_node_key
      : null
    if (!nextKey) {
      console.error(
        `[flows-cron] delayed run ${run.id}: smart_delay node ${run.current_node_key} missing next_node_key`,
      )
      continue
    }
    await advanceFromNodeKey(admin, { ...run, status: 'active', wake_at: null }, nextKey, nodes)
    woken += 1
  }

  return NextResponse.json({ swept, woken })
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
