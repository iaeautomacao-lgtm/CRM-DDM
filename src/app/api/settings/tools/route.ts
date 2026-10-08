import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { listAccountSecretNames } from '@/lib/ai/account-secrets'
import { loadToolUsage } from '@/lib/ai-tools/usage'
import {
  toPublicTool,
  toolHost,
  unknownSecretRefs,
  validateToolInput,
  type ToolRow,
} from '@/lib/ai-tools/tool-input'

// ============================================================
// /api/settings/tools — catálogo de ferramentas reutilizáveis (migration 176).
//
//   GET  supervisor+ : lista (com host, ligada/desligada e "usada em N fluxos").
//   POST owner/admin : cria. Recusa credencial literal (token/Authorization
//                      em texto → 400 "use {{cred.NOME}}"); {{cred/var}} que não
//                      existem na conta voltam como `warnings` (não bloqueiam).
// Service role + ctx.accountId. Nunca devolve valores de credenciais (a
// ferramenta só guarda marcadores).
// ============================================================

export async function GET() {
  const auth = await guardPermission('ai.tools.view')
  if (!auth.ok) return auth.response
  const { accountId } = auth.ctx

  const { data, error } = await supabaseAdmin()
    .from('ai_tools')
    .select('*')
    .eq('account_id', accountId)
    .order('name', { ascending: true })
  if (error) {
    console.error('[settings/tools] falha ao listar:', error.message)
    return NextResponse.json({ error: 'Não foi possível carregar as ferramentas.' }, { status: 500 })
  }
  let usage = new Map<string, Set<string>>()
  try {
    usage = await loadToolUsage(accountId)
  } catch (err) {
    console.error('[settings/tools] falha ao contar uso nos fluxos:', err instanceof Error ? err.message : err)
  }
  return NextResponse.json({
    tools: ((data ?? []) as ToolRow[]).map((row) => ({
      ...toPublicTool(row),
      host: toolHost(row.http.url),
      used_in_flows: usage.get(row.id)?.size ?? 0,
    })),
  })
}

export async function POST(request: Request) {
  const auth = await guardPermission('ai.tools.edit')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx

  const body = await request.json().catch(() => null)
  const input = validateToolInput(body)
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 })

  const { data, error } = await supabaseAdmin()
    .from('ai_tools')
    .insert({ account_id: accountId, created_by: userId, updated_by: userId, ...input.value })
    .select('*')
    .limit(1)
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `Já existe uma ferramenta chamada ${input.value.name}.` }, { status: 409 })
    }
    console.error('[settings/tools] falha ao criar:', error.code ?? error.message)
    return NextResponse.json({ error: 'Não foi possível salvar.' }, { status: 500 })
  }
  const warnings = unknownSecretRefs(input.value.http, await listAccountSecretNames(accountId))
  return NextResponse.json({ tool: toPublicTool((data as ToolRow[])[0]), warnings }, { status: 201 })
}
