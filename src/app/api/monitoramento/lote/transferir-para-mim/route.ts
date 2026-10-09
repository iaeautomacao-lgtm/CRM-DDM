import { NextResponse } from 'next/server'
import { registerAuditActor } from '@/lib/audit/context'
import { logAuditEvent } from '@/lib/audit/log-event'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { mapLimited, parseBatchIds, summarizeBatch, transferToMe } from '@/lib/conversations/batch'

// POST /api/monitoramento/lote/transferir-para-mim  { conversation_ids: uuid[] (1..50), reason? }
//
// "Transferir para mim" em lote (Monitoramento). Permissões: monitoring.view_team (tela) + inbox.transfer
// (a mesma da ação unitária /api/conversations/[id]/transfer); cada item segue as validações dela (visível
// pela RLS do usuário, mesma conta). Resposta 200 com resultado por item:
//   { summary: { total, ok, failed }, results: [{ conversation_id, ok, code?, error? }] }
// Itens já do usuário voltam ok com code 'already_mine'. A mensagem de "assumi o atendimento" ao cliente
// continua no cliente (sendTakeoverMessage), como na ação unitária. Auditoria: trigger por conversa
// (conversation_assignments/audit_logs) + um evento de lote.
const REASON_MAX = 500

export async function POST(request: Request) {
  try {
    await requirePermission('monitoring.view_team')
    const { supabase, accountId, userId } = await requirePermission('inbox.transfer')
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const parsed = parseBatchIds(body.conversation_ids)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    const reason = (typeof body.reason === 'string' ? body.reason.trim() : '').slice(0, REASON_MAX) || 'Transferência em lote para mim'

    await registerAuditActor({ source: 'monitoramento_lote', note: reason })
    const results = await mapLimited(parsed.ids, 5, (id) => transferToMe({ supabase, accountId, userId }, id, reason))
    const summary = summarizeBatch(results)

    await logAuditEvent({
      accountId,
      eventType: 'action',
      resourceType: 'conversation',
      resourceId: parsed.ids[0],
      action: 'conversation.batch_transferred_to_self',
      summary: `Transferência em lote para si: ${summary.ok} de ${summary.total} conversas`,
      metadata: { conversation_ids: parsed.ids, ok: summary.ok, failed: summary.failed, reason },
    })
    return NextResponse.json({ summary, results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
