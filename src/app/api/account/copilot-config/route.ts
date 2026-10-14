import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { COPILOT_DEFAULT_GUIDANCE, COPILOT_MAX_GUIDANCE_CHARS, loadCopilotConfig } from '@/lib/ai/copilot'
import { logAuditEvent } from '@/lib/audit/log-event'

export const dynamic = 'force-dynamic'

// GET/PUT /api/account/copilot-config  { enabled: boolean, guidance: string }   (Acordito — decisão do dono, 14/10)
// Ler: quem usa o inbox (inbox.view). Gravar: ai.config. A orientação (guidance) é texto da OPERAÇÃO, escrito pela tela;
// vazia, o servidor usa um padrão neutro mínimo (e o GET já devolve esse padrão para a tela mostrar).
export async function GET() {
  const auth = await guardPermission('inbox.view')
  if (!auth.ok) return auth.response
  const config = await loadCopilotConfig(supabaseAdmin(), auth.ctx.accountId)
  return NextResponse.json({ enabled: config.enabled, guidance: config.guidance.trim() || COPILOT_DEFAULT_GUIDANCE })
}

export async function PUT(request: Request) {
  const auth = await guardPermission('ai.config')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx

  const body = (await request.json().catch(() => null)) as { enabled?: unknown; guidance?: unknown } | null
  if (typeof body?.enabled !== 'boolean') return NextResponse.json({ error: 'enabled deve ser booleano' }, { status: 400 })
  if (typeof body.guidance !== 'string') return NextResponse.json({ error: 'guidance deve ser texto' }, { status: 400 })
  const guidance = body.guidance.trim()
  if (guidance.length > COPILOT_MAX_GUIDANCE_CHARS) {
    return NextResponse.json({ error: `guidance muito longa (máx. ${COPILOT_MAX_GUIDANCE_CHARS} caracteres)` }, { status: 413 })
  }

  const db = supabaseAdmin()
  const before = await loadCopilotConfig(db, accountId)
  const { error } = await db
    .from('copilot_config')
    .upsert({ account_id: accountId, enabled: body.enabled, guidance, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: 'account_id' })
  if (error) {
    console.error('[copilot-config] PUT falhou:', error.code ?? 'erro')
    return NextResponse.json({ error: 'Falha ao salvar a configuração do Acordito' }, { status: 500 })
  }

  // Auditoria sem o texto da orientação (só se mudou e o tamanho).
  const guidanceChanged = before.guidance.trim() !== guidance
  await logAuditEvent({
    accountId,
    eventType: 'updated',
    resourceType: 'copilot_config',
    resourceId: accountId,
    resourceLabel: 'Acordito',
    action: 'copilot.config_updated',
    summary: `Acordito ${body.enabled ? 'ligado' : 'desligado'}${guidanceChanged ? '; orientação alterada' : ''}`,
    changes: { enabled: { before: before.enabled, after: body.enabled } },
    metadata: { guidance_changed: guidanceChanged, guidance_chars: guidance.length },
  })
  return NextResponse.json({ enabled: body.enabled, guidance: guidance || COPILOT_DEFAULT_GUIDANCE })
}
