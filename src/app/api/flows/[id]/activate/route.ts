import { NextResponse } from 'next/server'
import { guardFlow } from '@/lib/flows/route-auth'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { listAccountSecretNames } from '@/lib/ai/account-secrets'
import { listAccountTools } from '@/lib/ai-tools/runtime'
import { listAccountAgents } from '@/lib/ai/agents/runtime'
import { recordFlowNodePromptVersions } from '@/lib/ai/prompt-versions'

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue. Drafts and archives are unconditional — users
 * need to be able to save broken-work-in-progress and pause flows
 * without first fixing them.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const guard = await guardFlow(id)
  if (!guard.ok) return guard.response
  const { userId, accountId } = guard.ctx

  const body = (await request.json().catch(() => null)) as
    | { status?: 'draft' | 'active' | 'archived' }
    | null
  const status = body?.status
  if (!status || !['draft', 'active', 'archived'].includes(status)) {
    return NextResponse.json(
      { error: "status deve ser 'draft', 'active' ou 'archived'" },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()
  // Nós que entram no ar — usados para o histórico de prompts abaixo.
  let activatedNodes: Array<Record<string, unknown>> | null = null

  if (status === 'active') {
    // Re-load with the full payload the validator needs.
    const [{ data: flow }, { data: nodes }] = await Promise.all([
      admin
        .from('flows')
        .select('account_id, name, trigger_type, trigger_config, entry_node_id')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle(),
      admin
        .from('flow_nodes')
        .select('node_key, node_type, config')
        .eq('flow_id', id),
    ])
    if (!flow) {
      return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
    }
    activatedNodes = nodes ?? []
    const { data: aiConfig } = await admin
      .from('ai_config')
      .select('api_provider')
      .eq('account_id', flow.account_id)
      .maybeSingle()

    const issues = validateFlowForActivation(
      flow as {
        name: string
        trigger_type: 'keyword' | 'first_inbound_message' | 'manual' | 'called_by_flow'
        trigger_config: Record<string, unknown>
        entry_node_id: string | null
      },
      (nodes ?? []) as Array<{
        node_key: string
        node_type: string
        config: Record<string, unknown>
      }>,
      {
        aiProvider: aiConfig?.api_provider ?? null,
        accountSecrets: await listAccountSecretNames(flow.account_id),
        aiTools: await listAccountTools(flow.account_id),
        agents: await listAccountAgents(admin, flow.account_id),
      },
    )
    const blockers = issues.filter((i) => i.severity === 'error')
    if (blockers.length > 0) {
      return NextResponse.json(
        {
          error: 'Não é possível ativar o fluxo — corrija primeiro os problemas abaixo.',
          issues,
        },
        { status: 422 },
      )
    }
  }

  const { data: updated, error } = await admin
    .from('flows')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  // Histórico de prompts (migration 148): o que entrou no ar ao ativar.
  // Texto já registrado só atualiza last_saved_at. Best-effort.
  if (activatedNodes && updated?.account_id) {
    await recordFlowNodePromptVersions(admin, {
      accountId: updated.account_id as string,
      flowId: id,
      nodes: activatedNodes,
      userId,
    })
  }
  return NextResponse.json({ flow: updated })
}
