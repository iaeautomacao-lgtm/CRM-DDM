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
