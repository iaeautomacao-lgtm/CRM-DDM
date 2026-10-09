import { NextResponse } from 'next/server'
import { registerAuditActor } from '@/lib/audit/context'
import { logAuditEvent } from '@/lib/audit/log-event'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { closeWithOutcome, mapLimited, parseBatchIds, summarizeBatch } from '@/lib/conversations/batch'

// POST /api/monitoramento/lote/finalizar  { conversation_ids: uuid[] (1..50), outcome_tag_id: uuid }
//
// "Finalizar com tabulação" em lote (Monitoramento). Permissões: monitoring.view_team (tela) + inbox.close
// (a mesma de /api/conversations/[id]/close). A tag precisa ser da conta e do tipo outcome (validada uma vez);
// cada item segue as validações da rota unitária e encerra o fluxo ativo. Resposta 200 com resultado por item:
//   { summary: { total, ok, failed }, results: [{ conversation_id, ok, code?, error? }] }
// Auditoria: trigger por conversa + um evento de lote.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  try {
    await requirePermission('monitoring.view_team')
    const { supabase, accountId, userId } = await requirePermission('inbox.close')
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const parsed = parseBatchIds(body.conversation_ids)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    const outcomeTagId = typeof body.outcome_tag_id === 'string' ? body.outcome_tag_id : ''
    if (!UUID_RE.test(outcomeTagId)) {
      return NextResponse.json({ error: 'Selecione uma tag de encerramento válida' }, { status: 400 })
    }
    const { data: tags, error: tagError } = await supabase
      .from('tags')
      .select('id')
      .eq('id', outcomeTagId)
      .eq('account_id', accountId)
      .eq('kind', 'outcome')
      .limit(1)
    if (tagError) throw tagError
    if (!tags?.[0]) return NextResponse.json({ error: 'Tag de encerramento inválida' }, { status: 400 })

    await registerAuditActor({ source: 'monitoramento_lote', note: 'Finalização em lote com tabulação' })
    const results = await mapLimited(parsed.ids, 5, (id) => closeWithOutcome({ supabase, accountId, userId }, id, outcomeTagId))
    const summary = summarizeBatch(results)

    await logAuditEvent({
      accountId,
      eventType: 'action',
      resourceType: 'conversation',
      resourceId: parsed.ids[0],
      action: 'conversation.batch_closed',
      summary: `Finalização em lote: ${summary.ok} de ${summary.total} conversas`,
      metadata: { conversation_ids: parsed.ids, ok: summary.ok, failed: summary.failed, outcome_tag_id: outcomeTagId },
    })
    return NextResponse.json({ summary, results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
