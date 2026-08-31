import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/flows/[id]/runs
 * GET /api/flows/[id]/runs?run_id=UUID
 * GET /api/flows/[id]/runs?status=completed&contact=maria&date_from=...&date_to=...
 *
 * Newest-first list of flow runs for a single flow. Used by the
 * run-history viewer page (`/flows/[id]/runs`) to give the owner
 * end-to-end visibility into what the bot did with each customer.
 *
 * Optional filters (all combinable, all applied before the limit):
 *   - status: exact match against flow_runs.status
 *   - contact: ILIKE against the run's contact name/phone. Resolved via
 *     a separate `contacts` lookup rather than an embedded-resource
 *     filter — keeps the flow_runs query a plain builder chain and
 *     avoids relying on PostgREST's inner-join-on-embed behavior.
 *   - date_from / date_to: ISO timestamps, inclusive bounds on started_at
 *
 * The event timeline is NOT bulk-fetched for every run on the list —
 * migration 061 added per-node `node_completed`/`node_error` logging
 * on top of the engine's existing events, so a flow with a lot of
 * traffic can have many events per run. Pass `?run_id=` to also get
 * that one run's `flow_run_events` timeline (fetched on demand when
 * the viewer expands a row).
 *
 * RLS does the ownership check (flow_runs has a `user_id` policy);
 * account scoping falls out of the same RLS join (flows.account_id →
 * caller's account via the flows/flow_runs policies), so no separate
 * account_id check is needed here.
 *
 * Limited to the 50 most recent (post-filter) runs. Pagination can
 * come later; the dashboard surface here is for debugging, not heavy
 * querying.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const params = new URL(request.url).searchParams
  const runId = params.get('run_id')
  const statusFilter = params.get('status')
  const contactFilter = params.get('contact')
  const dateFrom = params.get('date_from')
  const dateTo = params.get('date_to')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Confirm flow exists + caller owns it (RLS does this) before doing
  // the run query — gives us a clean 404 instead of empty array.
  const { data: flow } = await supabase
    .from('flows')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Resolve the contact filter to a set of contact_ids up front. Empty
  // matches short-circuit to an empty result — no point running the
  // flow_runs query when nothing could match.
  let contactIds: string[] | null = null
  if (contactFilter && contactFilter.trim()) {
    const like = contactFilter.trim().replace(/[%,]/g, '')
    const { data: matches } = await supabase
      .from('contacts')
      .select('id')
      .or(`name.ilike."%${like}%",phone.ilike."%${like}%"`)
    const resolvedIds = (matches ?? []).map((c: { id: string }) => c.id)
    if (resolvedIds.length === 0) {
      return NextResponse.json({ flow, runs: [], events: [] })
    }
    contactIds = resolvedIds
  }

  let runsQuery = supabase
    .from('flow_runs')
    .select(
      'id, status, current_node_key, started_at, last_advanced_at, ended_at, end_reason, vars, reprompt_count, hops_count, contact:contacts(id, name, phone)',
    )
    .eq('flow_id', id)
  if (statusFilter) runsQuery = runsQuery.eq('status', statusFilter)
  if (contactIds) runsQuery = runsQuery.in('contact_id', contactIds)
  if (dateFrom) runsQuery = runsQuery.gte('started_at', dateFrom)
  if (dateTo) runsQuery = runsQuery.lte('started_at', dateTo)

  const { data: runs, error: runsErr } = await runsQuery
    .order('started_at', { ascending: false })
    .limit(50)
  if (runsErr) {
    return NextResponse.json({ error: runsErr.message }, { status: 500 })
  }

  let events: Array<{
    flow_run_id: string
    event_type: string
    node_key: string | null
    node_type: string | null
    status: string | null
    error_message: string | null
    duration_ms: number | null
    payload: Record<string, unknown>
    created_at: string
  }> = []
  // Only fetch this specific run's events, and only when the caller
  // actually owns it (belongs to this flow) — `run_id` is
  // caller-supplied, so scope the events query through the runs list
  // we already fetched rather than trusting it directly.
  if (runId && (runs ?? []).some((r: { id: string }) => r.id === runId)) {
    const { data: evs, error: evsErr } = await supabase
      .from('flow_run_events')
      .select(
        'flow_run_id, event_type, node_key, node_type, status, error_message, duration_ms, payload, created_at',
      )
      .eq('flow_run_id', runId)
      .order('created_at', { ascending: true })
    if (evsErr) {
      // Non-fatal — the page can still show the run without its timeline.
      console.error('[flows-runs] events fetch failed:', evsErr.message)
    } else if (evs) {
      events = evs as typeof events
    }
  }

  return NextResponse.json({
    flow,
    runs: runs ?? [],
    events,
  })
}

/**
 * DELETE /api/flows/[id]/runs
 * Body: { ids: string[] }
 *
 * Bulk-deletes flow runs (and their event logs) from the run-history
 * viewer's selection / "excluir todas" actions. Goes through the
 * service-role admin client rather than the RLS-scoped `supabase`
 * client: flow_runs intentionally has no user-facing INSERT/UPDATE/
 * DELETE policy (see migration 010 — "the runner uses service_role for
 * all writes"), so this route does the account/flow scoping itself,
 * same pattern as end-run/route.ts.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  let ids: string[] = []
  try {
    const body = await request.json()
    ids = Array.isArray(body?.ids)
      ? body.ids.filter((v: unknown): v is string => typeof v === 'string')
      : []
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids is required' }, { status: 400 })
  }

  // Confirm the flow itself is visible to the caller's account (RLS on
  // `flows` scopes by account membership) before touching flow_runs —
  // gives a clean 404 instead of a silent no-op delete.
  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Re-scope the caller-supplied ids to this flow_id + account_id via
  // the admin client — defense in depth so a stray/forged id from
  // another flow or account can never be deleted.
  const admin = supabaseAdmin()
  const { data: matching, error: matchErr } = await admin
    .from('flow_runs')
    .select('id')
    .eq('flow_id', id)
    .eq('account_id', accountId)
    .in('id', ids)
  if (matchErr) {
    return NextResponse.json({ error: matchErr.message }, { status: 500 })
  }
  const scopedIds = (matching ?? []).map((r: { id: string }) => r.id)
  if (scopedIds.length === 0) {
    return NextResponse.json({ deleted: 0 })
  }

  // flow_run_events has an FK on flow_run_id with no ON DELETE clause
  // (append-only audit table — see migration 010) — must delete these
  // first or the flow_runs delete below fails on the constraint.
  const { error: eventsErr } = await admin
    .from('flow_run_events')
    .delete()
    .in('flow_run_id', scopedIds)
  if (eventsErr) {
    return NextResponse.json({ error: eventsErr.message }, { status: 500 })
  }

  const { error: runsErr } = await admin
    .from('flow_runs')
    .delete()
    .in('id', scopedIds)
  if (runsErr) {
    return NextResponse.json({ error: runsErr.message }, { status: 500 })
  }

  return NextResponse.json({ deleted: scopedIds.length })
}
