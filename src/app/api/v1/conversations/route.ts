import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import {
  decodeCursor,
  enforceExtractRateLimit,
  EXTRACT_DEFAULT_CONVERSATIONS,
  EXTRACT_MAX_CONVERSATIONS,
  loadConversationPage,
  parseConversationFilters,
  parseLimit,
} from '@/lib/api/v1/extract';
import { auditExtraction } from '@/lib/api/v1/extract-audit';
import { enforceConversationControlLimit } from '@/lib/api/v1/conversation-guard';
import { parseOpenBody } from '@/lib/api/v1/conversations-parse';
import { openConversation } from '@/lib/api/v1/conversations-open';
import { resolveActorUserId } from '@/lib/api/v1/contacts-db';
import { runIdempotentSend } from '@/lib/disparador/send-ledger';

// GET /api/v1/conversations (escopo conversations:read) — conversas da conta da chave, em ordem estável para extração incremental:
// por updated_at (padrão) ou, se closed_from/closed_to forem usados, por closed_at; desempate por id. Paginação por cursor.
// Filtros: updated_from/updated_to | closed_from/closed_to (ISO), status, channel, team_id, contact_id, phone. limit 1..500 (padrão 100).
// Cada conversa traz equipe, atendente, tabulação, contato (só id/nome/telefone), message_count e o histórico de transferências.
// Fora: CPF e demais dados sensíveis do contato, chat interno, notas internas e dados da IA. 60 req/min por chave.
export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/conversations', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceExtractRateLimit(ctx);

    const params = new URL(request.url).searchParams;
    const filters = parseConversationFilters(params);
    const limit = parseLimit(params.get('limit'), EXTRACT_DEFAULT_CONVERSATIONS, EXTRACT_MAX_CONVERSATIONS);
    const cursor = decodeCursor(params.get('cursor'), 3);

    const page = await loadConversationPage(ctx.supabase, { accountId: ctx.accountId, filters, cursor, limit });
    await auditExtraction({ accountId: ctx.accountId, keyId: ctx.keyId, route: '/api/v1/conversations', filters: { ...filters }, itemCount: page.items.length });
    return ok(page, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}

// POST /api/v1/conversations (escopo conversations:write) — abre (ou reaproveita) o atendimento de um contato num canal, com atendente OU equipe,
// mensagem inicial opcional (texto na janela de 24h da Meta, ou template) e force_transfer. Com `message` o `Idempotency-Key` é OBRIGATÓRIO
// (a mensagem nunca sai duas vezes); sem mensagem o pedido já é idempotente (repetir devolve a conversa aberta). Atendente em pausa: 409
// (`error.reason = agent_paused`) até vir `confirm_paused: true`. 30 req/min por chave. Contrato: OpenAPI (POST /conversations).
export async function POST(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'POST', route: '/api/v1/conversations', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceConversationControlLimit(ctx);

    const respond = (result: Awaited<ReturnType<typeof openConversation>>) =>
      ok(
        {
          conversation: { ...result.conversation, created: result.created },
          transferred: result.transferred,
          via_owner: result.via_owner,
          ...(result.message ? { message: result.message } : {}),
        },
        result.created ? 201 : 200,
        logCtx,
      );
    const run = async (onProviderCall: () => void) => {
      const body: unknown = await request.json().catch(() => null);
      const input = parseOpenBody(body);
      const actor = await resolveActorUserId(ctx.supabase, ctx.accountId, ctx.createdBy, ctx.userId);
      return respond(await openConversation(ctx.supabase, { accountId: ctx.accountId, actorUserId: actor, input, onProviderCall }));
    };

    // Com mensagem inicial a idempotência é obrigatória; só dá para saber lendo o corpo, então o corpo é lido dentro do controle.
    const peek: unknown = await request.clone().json().catch(() => null);
    const hasMessage = !!peek && typeof peek === 'object' && !Array.isArray(peek) && (peek as Record<string, unknown>).message != null;
    if (!hasMessage) return await run(() => {});
    return await runIdempotentSend(ctx.accountId, request, async (ctl) => run(() => ctl.providerCalled()), { apiEnvelope: true });
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
