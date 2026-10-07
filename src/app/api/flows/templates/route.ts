import { NextResponse } from 'next/server'
import { guardFlowAccess } from '@/lib/flows/route-auth'
import { listFlowTemplates } from '@/lib/flows/templates'

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Owner/admin (mesmo papel da página /flows).
 */
export async function GET() {
  const guard = await guardFlowAccess()
  if (!guard.ok) return guard.response
  // Shallow shape so the client gallery doesn't have to know about
  // the full node tree.
  const templates = listFlowTemplates().map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
  }))
  return NextResponse.json({ templates })
}
