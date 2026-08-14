import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * POST /api/flows/import — recreate a flow from an exported JSON file
 * (see GET /api/flows/[id]/export for the shape produced).
 *
 * Always lands as a new 'draft' flow named "<original> (importado)" —
 * never overwrites an existing flow. Nodes get fresh UUIDs (the DB
 * default), but `node_key` is preserved as-is so in-config edges
 * (which reference node_key, not id — see migration 010) keep working
 * without any rewriting.
 */

const TRIGGER_TYPES = new Set([
  'keyword',
  'first_inbound_message',
  'manual',
  'called_by_flow',
])

const NODE_TYPES = new Set([
  'start',
  'send_message',
  'send_buttons',
  'send_list',
  'send_media',
  'collect_input',
  'condition',
  'set_tag',
  'handoff',
  'http_fetch',
  'end',
  'set_variable',
  'smart_delay',
  'anchor',
  'go_to',
  'go_to_flow',
  'send_template',
  'add_note',
  'receive_attachment',
  'ai_agent',
])

interface ImportNode {
  node_key?: string
  node_type?: string
  config?: Record<string, unknown>
  position_x?: number
  position_y?: number
}

interface ImportPayload {
  version?: string
  flow?: {
    name?: string
    description?: string | null
    trigger_type?: string
    trigger_config?: Record<string, unknown>
  }
  nodes?: ImportNode[]
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Resolve the caller's account_id — `flows.account_id` is NOT NULL,
  // so an INSERT without it trips the not-null constraint even though
  // the admin client below bypasses RLS.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const body = (await request.json().catch(() => null)) as ImportPayload | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (body.version !== '1.0') {
    return NextResponse.json(
      {
        error: `Arquivo inválido: versão "${body.version ?? 'ausente'}" não suportada (esperado "1.0").`,
      },
      { status: 400 },
    )
  }
  if (!body.flow || typeof body.flow.name !== 'string' || !body.flow.name.trim()) {
    return NextResponse.json(
      { error: 'Arquivo inválido: "flow.name" precisa ser um texto não vazio.' },
      { status: 400 },
    )
  }
  if (!TRIGGER_TYPES.has(body.flow.trigger_type ?? '')) {
    return NextResponse.json(
      {
        error: `Arquivo inválido: "flow.trigger_type" ("${body.flow.trigger_type ?? 'ausente'}") não é válido. Valores aceitos: ${[...TRIGGER_TYPES].join(', ')}.`,
      },
      { status: 400 },
    )
  }
  if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
    return NextResponse.json(
      { error: 'Arquivo inválido: "nodes" precisa ser uma lista com ao menos 1 item.' },
      { status: 400 },
    )
  }
  for (const [index, node] of body.nodes.entries()) {
    if (!node || typeof node.node_key !== 'string' || !node.node_key.trim()) {
      return NextResponse.json(
        { error: `Arquivo inválido: o nó #${index + 1} precisa de "node_key".` },
        { status: 400 },
      )
    }
    if (typeof node.node_type !== 'string' || !NODE_TYPES.has(node.node_type)) {
      return NextResponse.json(
        {
          error: `Arquivo inválido: o nó #${index + 1} tem "node_type" ("${node.node_type ?? 'ausente'}") inválido. Valores aceitos: ${[...NODE_TYPES].join(', ')}.`,
        },
        { status: 400 },
      )
    }
  }

  const trigger_type = body.flow.trigger_type as string

  const admin = supabaseAdmin()

  const { data: flow, error: flowErr } = await admin
    .from('flows')
    .insert({
      user_id: user.id,
      account_id: accountId,
      name: `${body.flow.name.trim()} (importado)`,
      description: body.flow.description ?? null,
      status: 'draft',
      trigger_type,
      trigger_config: body.flow.trigger_config ?? {},
    })
    .select()
    .single()
  if (flowErr || !flow) {
    return NextResponse.json(
      { error: flowErr?.message ?? 'flow insert failed' },
      { status: 500 },
    )
  }

  if (body.nodes.length > 0) {
    const { error: nodesErr } = await admin.from('flow_nodes').insert(
      body.nodes.map((n) => ({
        flow_id: flow.id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config ?? {},
        position_x: n.position_x ?? 0,
        position_y: n.position_y ?? 0,
      })),
    )
    if (nodesErr) {
      // Roll back the parent flow so an invalid import doesn't leave a
      // half-populated draft behind — mirrors the template clone path
      // in POST /api/flows.
      await admin.from('flows').delete().eq('id', flow.id)
      return NextResponse.json({ error: nodesErr.message }, { status: 400 })
    }
  }

  return NextResponse.json({ flow_id: flow.id }, { status: 201 })
}
