// POST /api/v1/conversations/{id}/close (escopo conversations:write) — encerra a conversa com uma tabulação ({ tabulation_code | tabulation_id, note? })
// e dispara os eventos que já existem (conversation.closed e, com a tabulação 142, agreement.created). A observação vira nota do contato (nunca vai
// ao cliente). Idempotente: já encerrada com a MESMA tabulação = 200 changed:false; com outra = 409 (reason already_closed). 30 req/min por chave.
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, notFound, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { enforceConversationControlLimit } from '@/lib/api/v1/conversation-guard';
import { closeConversation, loadConversation, resolveTabulation } from '@/lib/api/v1/conversations-control';
import { isUuid, parseCloseBody } from '@/lib/api/v1/conversations-parse';
import { resolveActorUserId } from '@/lib/api/v1/contacts-db';
import { endActiveRunForConversation } from '@/lib/flows/engine';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: 'POST', route: '/api/v1/conversations/{id}/close', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceConversationControlLimit(ctx);

    const { id } = await params;
    if (!isUuid(id)) throw notFound('Conversa não encontrada');
    const input = parseCloseBody(await request.json().catch(() => null));

    const conversation = await loadConversation(ctx.supabase, ctx.accountId, id);
    const tabulation = await resolveTabulation(ctx.supabase, ctx.accountId, { id: input.tabulationId, code: input.tabulationCode });
    const noteAuthor = await resolveActorUserId(ctx.supabase, ctx.accountId, ctx.createdBy, ctx.userId);
    const result = await closeConversation(ctx.supabase, {
      accountId: ctx.accountId,
      conversation,
      tabulation,
      note: input.note,
      actorUserId: ctx.createdBy,
      noteAuthorId: noteAuthor,
    });

    if (result.changed) {
      // Melhor esforço: encerrar é o sinal mais forte de que qualquer fluxo desta conversa deve parar.
      try {
        await endActiveRunForConversation(id, 'conversation_closed');
      } catch (err) {
        console.error('[API conversations/close] não foi possível encerrar o fluxo ativo:', err instanceof Error ? err.message : 'erro');
      }
    }
    return ok(
      {
        conversation: {
          id: result.conversation.id,
          status: result.conversation.status,
          outcome: { id: tabulation.id, code: tabulation.code, name: tabulation.name },
          closed_at: result.conversation.closed_at,
        },
        changed: result.changed,
      },
      200,
      logCtx,
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
