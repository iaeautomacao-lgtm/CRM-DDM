import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/flows/[id]/export — download a flow definition as JSON.
 *
 * Read-only, RLS-scoped (the request uses the caller's own supabase
 * client, not the admin client) — a flow owned by another account
 * 404s via the same `is_account_member` policy every other flows
 * route relies on.
 */

async function requireOwnership(
  flowId: string,
): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', flowId)
    .maybeSingle()
  if (!flow) {
    return { ok: false, status: 404, body: { error: 'Not found' } }
  }
  return { ok: true, supabase }
}

const DIACRITICS_RE = new RegExp('[̀-ͯ]', 'g')

function slugifyFilename(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'fluxo'
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })
  const { supabase } = guard

  const [{ data: flow }, { data: nodes }] = await Promise.all([
    supabase.from('flows').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ])
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const payload = {
    version: '1.0',
    exported_at: new Date().toISOString(),
    flow: {
      name: flow.name,
      description: flow.description,
      trigger_type: flow.trigger_type,
      trigger_config: flow.trigger_config,
    },
    nodes: (nodes ?? []).map(
      (n: {
        node_key: string
        node_type: string
        config: Record<string, unknown>
        position_x: number
        position_y: number
      }) => ({
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config,
        position_x: n.position_x,
        position_y: n.position_y,
      }),
    ),
  }

  const filename = `${slugifyFilename(flow.name)}.json`
  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
