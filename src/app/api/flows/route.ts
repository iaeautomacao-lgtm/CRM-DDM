import { NextResponse } from 'next/server'
import { guardFlowAccess } from '@/lib/flows/route-auth'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getFlowTemplate } from '@/lib/flows/templates'
import { pageRange, parsePageParams, splitPage } from '@/lib/pagination'

/**
 * GET /api/flows — list the caller's flows. Sem parâmetros devolve todos (compatível com quem já consome a lista);
 * com `?limit=N&offset=M` (N até 200) devolve uma página e `has_more`, para a tela carregar "mais" sob demanda.
 * POST /api/flows — create a new (draft) flow.
 *
 * Owner/admin only (mesmo papel da página /flows). Tudo escopado pela
 * conta do chamador.
 */

export async function GET(request?: Request) {
  const guard = await guardFlowAccess()
  if (!guard.ok) return guard.response
  const { supabase, accountId } = guard.ctx

  const { limit, offset } = parsePageParams(new URL(request?.url ?? 'http://localhost/').searchParams, { defaultLimit: null, maxLimit: 200 })

  let query = supabase
    .from('flows')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
  if (limit !== null) {
    const [from, to] = pageRange({ limit, offset })
    query = query.range(from, to)
  }
  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (limit === null) return NextResponse.json({ flows: data ?? [], has_more: false })
  const page = splitPage(data ?? [], limit)
  return NextResponse.json({ flows: page.rows, has_more: page.hasMore })
}

export async function POST(request: Request) {
  const guard = await guardFlowAccess()
  if (!guard.ok) return guard.response
  const { userId, accountId } = guard.ctx

  const body = (await request.json().catch(() => null)) as
    | {
        name?: string
        description?: string | null
        trigger_type?: 'keyword' | 'first_inbound_message' | 'manual' | 'called_by_flow'
        trigger_config?: Record<string, unknown>
        /**
         * If set, clone the matching template's name + trigger +
         * entry_node_id + nodes[] into a fresh draft for this user.
         * `name` from the body overrides the template default if
         * provided.
         */
        template_slug?: string
      }
    | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // -------- Template clone path --------
  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug)
    if (!template) {
      return NextResponse.json(
        { error: `Unknown template_slug "${body.template_slug}"` },
        { status: 400 },
      )
    }
    const { data: flow, error: flowErr } = await admin
      .from('flows')
      .insert({
        user_id: userId,
        account_id: accountId,
        name: body.name?.trim() || template.name,
        description: template.description,
        status: 'draft',
        trigger_type: template.trigger_type,
        trigger_config: template.trigger_config,
        entry_node_id: template.entry_node_id,
      })
      .select()
      .single()
    if (flowErr || !flow) {
      return NextResponse.json(
        { error: flowErr?.message ?? 'flow insert failed' },
        { status: 500 },
      )
    }
    if (template.nodes.length > 0) {
      const { error: nodesErr } = await admin.from('flow_nodes').insert(
        template.nodes.map((n) => ({
          flow_id: flow.id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
        })),
      )
      if (nodesErr) {
        // Roll back the parent flow so a half-cloned template doesn't
        // sit as an empty draft. CASCADE on flow_id removes the
        // (probably zero) nodes too.
        await admin.from('flows').delete().eq('id', flow.id)
        return NextResponse.json(
          { error: nodesErr.message },
          { status: 500 },
        )
      }
    }
    return NextResponse.json({ flow }, { status: 201 })
  }

  // -------- Plain (empty) create path --------
  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const trigger_type = body.trigger_type ?? 'keyword'

  const { data, error } = await admin
    .from('flows')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: body.name.trim(),
      description: body.description ?? null,
      status: 'draft',
      trigger_type,
      trigger_config: body.trigger_config ?? {},
    })
    .select()
    .single()
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'insert failed' },
      { status: 500 },
    )
  }
  return NextResponse.json({ flow: data }, { status: 201 })
}
