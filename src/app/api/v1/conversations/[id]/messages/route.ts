import { requireApiKey } from '@/lib/auth/api-context';
import { notFound, ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import {
  decodeCursor,
  enforceExtractRateLimit,
  EXTRACT_DEFAULT_MESSAGES,
  EXTRACT_MAX_MESSAGES,
  isUuid,
  loadMessagePage,
  parseLimit,
} from '@/lib/api/v1/extract';
import { auditExtraction } from '@/lib/api/v1/extract-audit';

// GET /api/v1/conversations/{id}/messages (escopo messages:read) — as mensagens da conversa EM ORDEM (created_at, id) ascendente,
// com seq (posição 1..N estável na conversa), horário ISO UTC, direction, author {type,id,name}, conteúdo e mídia SEM URL.
// include_media_urls=true devolve URL assinada de 15 min. Paginação por cursor, limit 1..1000 (padrão 500). 60 req/min por chave.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/conversations/{id}/messages', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceExtractRateLimit(ctx);

    const { id } = await params;
    if (!isUuid(id)) throw notFound('Conversa não encontrada');
    const search = new URL(request.url).searchParams;
    const limit = parseLimit(search.get('limit'), EXTRACT_DEFAULT_MESSAGES, EXTRACT_MAX_MESSAGES);
    const cursor = decodeCursor(search.get('cursor'), 2);
    const includeMediaUrls = search.get('include_media_urls') === 'true';

    // A conversa precisa ser da conta da chave (outra conta = 404, indistinguível de inexistente).
    const { data: conv, error } = await ctx.supabase.from('conversations').select('id').eq('id', id).eq('account_id', ctx.accountId).limit(1);
    if (error) throw error;
    if (!conv?.[0]) throw notFound('Conversa não encontrada');

    const page = await loadMessagePage(ctx.supabase, { accountId: ctx.accountId, conversationId: id, cursor, limit, includeMediaUrls });
    await auditExtraction({
      accountId: ctx.accountId,
      keyId: ctx.keyId,
      route: '/api/v1/conversations/{id}/messages',
      filters: { conversation_id: id, include_media_urls: includeMediaUrls },
      itemCount: page.items.length,
    });
    return ok(page, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
