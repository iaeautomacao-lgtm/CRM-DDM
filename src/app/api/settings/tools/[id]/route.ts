import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { listAccountSecretNames } from '@/lib/ai/account-secrets'
import { loadToolUsage } from '@/lib/ai-tools/usage'
import { toPublicTool, unknownSecretRefs, validateToolInput, type ToolRow } from '@/lib/ai-tools/tool-input'

// PATCH/DELETE de uma ferramenta do catálogo (owner/admin).
//  - PATCH { enabled } liga/desliga sem revalidar o resto.
//  - PATCH com outros campos: mescla com o atual e valida tudo de novo
//    (credencial literal → 400). O nome da função é imutável (fluxos e o
//    histórico dos agentes usam o nome).
//  - DELETE: 409 se algum agente (qualquer versão) usa a ferramenta — sem
//    exceção; 409 se algum fluxo usa (use ?force=true para apagar
//    mesmo assim; o validador do fluxo passa a acusar a referência quebrada).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadOwn(id: string, accountId: string): Promise<ToolRow | null> {
  const { data } = await supabaseAdmin().from('ai_tools').select('*').eq('id', id).eq('account_id', accountId).limit(1)
  return ((data ?? []) as ToolRow[])[0] ?? null
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await guardPermission('ai.tools.edit')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx
  if (!UUID.test(id)) return NextResponse.json({ error: 'Não encontrada.' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 })
  }
  const existing = await loadOwn(id, accountId)
  if (!existing) return NextResponse.json({ error: 'Não encontrada.' }, { status: 404 })
  if (body.name !== undefined && body.name !== existing.name) {
    return NextResponse.json({ error: 'O nome da função não pode ser alterado (os fluxos usam o nome).' }, { status: 400 })
  }

  const keys = Object.keys(body)
  let update: Record<string, unknown>
  let warnings: string[] = []
  if (keys.length === 1 && keys[0] === 'enabled') {
    if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'O campo ligada/desligada é inválido.' }, { status: 400 })
    update = { enabled: body.enabled }
  } else {
    const merged = {
      name: existing.name,
      display_name: existing.display_name,
      description: existing.description,
      parameters: existing.parameters,
      http: existing.http,
      timeout_ms: existing.timeout_ms,
      enabled: existing.enabled,
      ...body,
    }
    const input = validateToolInput(merged)
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 })
    update = { ...input.value }
    warnings = unknownSecretRefs(input.value.http, await listAccountSecretNames(accountId))
  }

  const { data, error } = await supabaseAdmin()
    .from('ai_tools')
    .update({ ...update, updated_by: userId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select('*')
    .limit(1)
  if (error || !data?.length) {
    console.error('[settings/tools] falha ao atualizar:', error?.code ?? 'sem linha')
    return NextResponse.json({ error: 'Não foi possível salvar.' }, { status: 500 })
  }
  return NextResponse.json({ tool: toPublicTool((data as ToolRow[])[0]), warnings })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await guardPermission('ai.tools.edit')
  if (!auth.ok) return auth.response
  const { accountId } = auth.ctx
  if (!UUID.test(id)) return NextResponse.json({ error: 'Não encontrada.' }, { status: 404 })
  if (!(await loadOwn(id, accountId))) return NextResponse.json({ error: 'Não encontrada.' }, { status: 404 })

  // Versão de agente que referencia a ferramenta impede o DELETE (FK da 180):
  // apagar quebraria o histórico/rollback do agente. Nem o force passa.
  const { data: agentRefs, error: agentRefsError } = await supabaseAdmin()
    .from('ai_agent_tools')
    .select('agent_version_id')
    .eq('account_id', accountId)
    .eq('tool_id', id)
    .limit(1)
  if (agentRefsError) {
    console.error('[settings/tools] falha ao checar uso por agentes:', agentRefsError.code ?? agentRefsError.message)
    return NextResponse.json({ error: 'Não foi possível apagar.' }, { status: 500 })
  }
  if ((agentRefs ?? []).length > 0) {
    return NextResponse.json(
      { error: 'Esta ferramenta é usada por agentes (inclusive em versões anteriores). Desligue-a em vez de excluir.', used_by_agents: true },
      { status: 409 },
    )
  }

  const force = new URL(request.url).searchParams.get('force') === 'true'
  if (!force) {
    const usage = await loadToolUsage(accountId).catch(() => null)
    const used = usage?.get(id)?.size ?? 0
    if (used > 0) {
      return NextResponse.json(
        { error: `Esta ferramenta é usada em ${used} fluxo(s). Remova-a dos fluxos ou confirme para apagar mesmo assim.`, used_in_flows: used },
        { status: 409 },
      )
    }
  }
  const { error } = await supabaseAdmin().from('ai_tools').delete().eq('id', id).eq('account_id', accountId)
  if (error) {
    console.error('[settings/tools] falha ao apagar:', error.code ?? error.message)
    return NextResponse.json({ error: 'Não foi possível apagar.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
