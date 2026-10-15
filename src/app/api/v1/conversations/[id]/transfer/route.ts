// POST /api/v1/conversations/{id}/transfer (escopo conversations:write) — transfere para atendente e/ou equipe ({ assignee_id?, team_id?, confirm_paused?,
// reason? }; null remove). Atendente EM PAUSA: 409 (`error.reason = agent_paused`, com `agent` e `pause`) até vir `confirm_paused: true`; a confirmação fica
// marcada na auditoria. Conversa encerrada = 409 (reason conversation_closed). Sem mudança (já era dele) = 200 changed:false. 30 req/min por chave.
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, notFound, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { enforceConversationControlLimit } from '@/lib/api/v1/conversation-guard';
import { loadConversation, toConversationView, transferConversation } from '@/lib/api/v1/conversations-control';
import { isUuid, parseTransferBody } from '@/lib/api/v1/conversations-parse';
import { registerAuditActor } from '@/lib/audit/context';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: 'POST', route: '/api/v1/conversations/{id}/transfer', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceConversationControlLimit(ctx);

    const { id } = await params;
    if (!isUuid(id)) throw notFound('Conversa não encontrada');
    const input = parseTransferBody(await request.json().catch(() => null));
    const conversation = await loadConversation(ctx.supabase, ctx.accountId, id);

    // A observação (motivo) entra na auditoria do banco; a origem é a API (sem nome de usuário: quem age é a chave).
    await registerAuditActor({ actorType: 'api', source: 'api_v1', ...(input.reason ? { note: input.reason } : {}) });
    const result = await transferConversation(ctx.supabase, {
      accountId: ctx.accountId,
      conversation,
      assigneeId: input.assigneeId,
      teamId: input.teamId,
      confirmPaused: input.confirmPaused,
      actorUserId: ctx.createdBy,
      reason: input.reason,
    });
    return ok({ conversation: toConversationView(result.conversation), changed: result.changed }, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
