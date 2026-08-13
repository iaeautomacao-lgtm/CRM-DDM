import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/flows/[id]/runs
 * GET /api/flows/[id]/runs?run_id=UUID
 *
 * Newest-first list of flow runs for a single flow. Used by the
 * run-history viewer page (`/flows/[id]/runs`) to give the owner
 * end-to-end visibility into what the bot did with each customer.
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
 * Limited to the 50 most recent runs. Pagination can come later;
 * the dashboard surface here is for debugging, not heavy querying.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const runId = new URL(request.url).searchParams.get('run_id')

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

  const { data: runs, error: runsErr } = await supabase
    .from('flow_runs')
    .select(
      'id, status, current_node_key, started_at, last_advanced_at, ended_at, end_reason, vars, reprompt_count, hops_count, contact:contacts(id, name, phone)',
    )
    .eq('flow_id', id)
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
