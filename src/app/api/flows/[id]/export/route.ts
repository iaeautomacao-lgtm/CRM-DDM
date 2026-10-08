import { NextResponse } from 'next/server'
import { guardFlow } from '@/lib/flows/route-auth'

/**
 * GET /api/flows/[id]/export — download a flow definition as JSON.
 *
 * Read-only, owner/admin, RLS-scoped (the request uses the caller's own
 * supabase client, not the admin client) — a flow owned by another
 * account 404s.
 */

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
  const guard = await guardFlow(id)
  if (!guard.ok) return guard.response
  const { supabase, accountId } = guard.ctx

  const [{ data: flow }, { data: nodes }] = await Promise.all([
    supabase.from('flows').select('*').eq('id', id).eq('account_id', accountId).maybeSingle(),
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
