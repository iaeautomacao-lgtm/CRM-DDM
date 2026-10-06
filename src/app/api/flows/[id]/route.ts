import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateFlowForActivation } from '@/lib/flows/validate'

/**
 * GET   /api/flows/[id]  — fetch one flow with its nodes.
 * PUT   /api/flows/[id]  — replace name/trigger/entry/fallback + the
 *                          full node graph (delete-then-insert under
 *                          the hood; not atomic, but the runner is
 *                          resilient to mid-edit reads — node_not_found
 *                          gracefully ends the run).
 * DELETE /api/flows/[id] — hard delete (RLS+CASCADE clean up nodes,
 *                          runs, events).
 *
 * All three require a signed-in caller who owns the flow. Flows is in
 * soft-GA — the beta gate that previously 404'd non-beta accounts is
 * gone; the "Beta" label in the UI is the only remaining signal.
 */

async function requireOwnership(
  flowId: string,
): Promise<
  | {
      ok: true
      userId: string
      supabase: Awaited<ReturnType<typeof createClient>>
    }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  // RLS scopes this to the caller — a flow owned by another user
  // returns null (404 below).
  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', flowId)
    .maybeSingle()
  if (!flow) {
    return { ok: false, status: 404, body: { error: 'Not found' } }
  }
  return { ok: true, userId: user.id, supabase }
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
  return NextResponse.json({ flow, nodes: nodes ?? [] })
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual' | 'called_by_flow'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  /** updated_at que o editor carregou — se mudou, outra aba/pessoa salvou. */
  expected_updated_at?: string
  /** O usuário confirmou publicar mesmo com clientes parados em nós removidos. */
  confirm_orphan_runs?: boolean
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  const body = (await request.json().catch(() => null)) as PutBody | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json(
      { error: 'name cannot be empty' },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  // Duas abas (ou duas pessoas) no mesmo fluxo: sem isto o autosave da aba
  // antiga sobrescrevia o trabalho da outra em silêncio.
  if (body.expected_updated_at) {
    const { data: currentVersion } = await admin
      .from('flows')
      .select('updated_at')
      .eq('id', id)
      .maybeSingle()
    const current = currentVersion?.updated_at ? new Date(currentVersion.updated_at).getTime() : null
    const expected = new Date(body.expected_updated_at).getTime()
    if (current !== null && Number.isFinite(expected) && current !== expected) {
      return NextResponse.json(
        {
          error: 'Este fluxo foi alterado em outra aba ou por outra pessoa. Recarregue a página para ver a versão atual antes de salvar.',
          code: 'conflict',
        },
        { status: 409 },
      )
    }
  }

  // Fluxo ativo atende clientes reais: alteração de nós/gatilho só entra
  // se o resultado continuar válido (PRD-01). Rascunho salva como antes.
  if (
    body.nodes !== undefined &&
    (!Array.isArray(body.nodes) ||
      body.nodes.some((n) => !n || typeof n.node_key !== 'string' || typeof n.config !== 'object' || n.config === null))
  ) {
    return NextResponse.json({ error: 'nodes inválido' }, { status: 400 })
  }
  if (
    body.nodes !== undefined ||
    body.trigger_type !== undefined ||
    body.trigger_config !== undefined ||
    body.entry_node_id !== undefined
  ) {
    const { data: current } = await admin
      .from('flows')
      .select('account_id, status, name, trigger_type, trigger_config, entry_node_id')
      .eq('id', id)
      .maybeSingle()
    if (current?.status === 'active') {
      let nodes = body.nodes
      if (nodes === undefined) {
        const { data: existing } = await admin
          .from('flow_nodes')
          .select('node_key, node_type, config')
          .eq('flow_id', id)
        nodes = (existing ?? []) as NonNullable<PutBody['nodes']>
      }
      const { data: aiConfig } = await admin
        .from('ai_config')
        .select('api_provider')
        .eq('account_id', current.account_id)
        .maybeSingle()

      const blockers = validateFlowForActivation(
        {
          name: body.name ?? current.name,
          trigger_type: body.trigger_type ?? current.trigger_type,
          trigger_config: body.trigger_config ?? current.trigger_config,
          entry_node_id: body.entry_node_id !== undefined ? body.entry_node_id : current.entry_node_id,
        },
        nodes,
        { aiProvider: aiConfig?.api_provider ?? null },
      ).filter((i) => i.severity === 'error')
      if (blockers.length > 0) {
        return NextResponse.json(
          { error: 'Fluxo ativo: corrija os erros antes de publicar as alterações.', issues: blockers },
          { status: 400 },
        )
      }
      // Clientes parados (execução em andamento) num nó que esta versão
      // remove ou renomeia: ao publicar, essas execuções terminam com "nó
      // não encontrado". Pede confirmação explícita antes.
      if (body.nodes !== undefined && !body.confirm_orphan_runs) {
        const newKeys = new Set(body.nodes.map((n) => n.node_key))
        const { data: liveRuns } = await admin
          .from('flow_runs')
          .select('current_node_key')
          .eq('flow_id', id)
          .in('status', ['active', 'paused_by_agent'])
          .range(0, 4999)
        const orphaned = (liveRuns ?? []).filter(
          (r: { current_node_key: string | null }) => r.current_node_key && !newKeys.has(r.current_node_key),
        )
        if (orphaned.length > 0) {
          const nodesHit = [...new Set(orphaned.map((r: { current_node_key: string | null }) => r.current_node_key))]
          return NextResponse.json(
            {
              error: `${orphaned.length} cliente(s) estão agora em nó(s) que esta alteração remove (${nodesHit.join(', ')}). Publicando, essas execuções serão encerradas.`,
              code: 'orphan_runs',
              count: orphaned.length,
            },
            { status: 409 },
          )
        }
      }
    }
  }

  // Chave repetida faria o insert falhar depois de apagar os nós.
  if (body.nodes !== undefined) {
    const seen = new Set<string>()
    for (const n of body.nodes) {
      if (seen.has(n.node_key)) {
        return NextResponse.json(
          { error: `Chave de nó repetida: "${n.node_key}". Renomeie um dos nós.` },
          { status: 400 },
        )
      }
      seen.add(n.node_key)
    }
  }

  // Update the flow row first — the body may not include `nodes` (a
  // header-only save for editing the trigger config without touching
  // the graph). Skip node replacement in that case.
  const flowPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (body.name !== undefined) flowPatch.name = body.name.trim()
  if (body.description !== undefined)
    flowPatch.description = body.description
  if (body.trigger_type !== undefined) flowPatch.trigger_type = body.trigger_type
  if (body.trigger_config !== undefined)
    flowPatch.trigger_config = body.trigger_config
  if (body.entry_node_id !== undefined)
    flowPatch.entry_node_id = body.entry_node_id
  if (body.fallback_policy !== undefined)
    flowPatch.fallback_policy = body.fallback_policy

  const { error: updErr } = await admin
    .from('flows')
    .update(flowPatch)
    .eq('id', id)
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  if (body.nodes !== undefined) {
    // Delete-then-insert (sem transação no PostgREST). Guarda os nós
    // atuais antes: se o insert falhar, eles voltam — antes o fluxo
    // ficava sem nenhum nó no banco.
    const { data: previousNodes, error: prevErr } = await admin
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at')
      .range(0, 999)
    if (prevErr) {
      return NextResponse.json({ error: prevErr.message }, { status: 500 })
    }
    const { error: delErr } = await admin
      .from('flow_nodes')
      .delete()
      .eq('flow_id', id)
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 })
    }
    if (body.nodes.length > 0) {
      // created_at escalonado (1 ms por nó) mantém a ordem da Lista ao
      // recarregar — antes todos tinham o mesmo instante e a ordem variava.
      const base = Date.now()
      const { error: insErr } = await admin.from('flow_nodes').insert(
        body.nodes.map((n, i) => ({
          flow_id: id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
          position_x: n.position_x ?? 0,
          position_y: n.position_y ?? 0,
          created_at: new Date(base + i).toISOString(),
        })),
      )
      if (insErr) {
        if (previousNodes && previousNodes.length > 0) {
          const { error: restoreErr } = await admin.from('flow_nodes').insert(previousNodes)
          if (restoreErr) console.error('[flows PUT] falha ao restaurar nós:', restoreErr.message)
        }
        return NextResponse.json(
          { error: `Falha ao salvar os nós (nada foi alterado): ${insErr.message}` },
          { status: 500 },
        )
      }
    }
  }

  // Re-fetch and return the new state — the editor uses the response
  // to reconcile its local form state.
  const [{ data: flow }, { data: nodes }] = await Promise.all([
    admin.from('flows').select('*').eq('id', id).maybeSingle(),
    admin
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ])
  return NextResponse.json({ flow, nodes: nodes ?? [] })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  // CASCADE on flow_nodes / flow_runs / flow_run_events handles the
  // children. Active runs end abruptly — there's no graceful "drain"
  // mechanism in v1, but that's intentional: deleting a flow is a
  // deliberate destructive action and the partial unique index will
  // free up the contact for new triggers immediately.
  const { error } = await supabaseAdmin().from('flows').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

