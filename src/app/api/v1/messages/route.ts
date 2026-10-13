import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import {
  decodeCursor,
  enforceExtractRateLimit,
  EXTRACT_DEFAULT_MESSAGES,
  EXTRACT_MAX_MESSAGES,
  EXTRACT_MAX_PERIOD_DAYS,
  loadMessagePage,
  parseChannel,
  parseIso,
  parseLimit,
  parseUuidParam,
} from '@/lib/api/v1/extract';
import { auditExtraction } from '@/lib/api/v1/extract-audit';

// GET /api/v1/messages (escopo messages:read) — extração em massa por PERÍODO, entre conversas. from e to obrigatórios (ISO; to
// exclusivo), no máximo 31 dias por chamada. Filtros: channel, team_id. Ordem (created_at, id) ascendente, cursor, limit 1..1000.
// Mesmo formato de /conversations/{id}/messages (seq = posição na conversa). 60 req/min por chave.
export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/messages', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceExtractRateLimit(ctx);

    const search = new URL(request.url).searchParams;
    const from = parseIso(search.get('from'), 'from');
    const to = parseIso(search.get('to'), 'to');
    if (!from || !to) throw badRequest("'from' e 'to' são obrigatórios (datas ISO 8601)");
    if (to <= from) throw badRequest("'to' deve ser depois de 'from'");
    if (Date.parse(to) - Date.parse(from) > EXTRACT_MAX_PERIOD_DAYS * 86_400_000) {
      throw badRequest(`O período máximo é de ${EXTRACT_MAX_PERIOD_DAYS} dias por chamada`);
    }
    const channel = parseChannel(search.get('channel'));
    const teamId = parseUuidParam(search.get('team_id'), 'team_id');
    const limit = parseLimit(search.get('limit'), EXTRACT_DEFAULT_MESSAGES, EXTRACT_MAX_MESSAGES);
    const cursor = decodeCursor(search.get('cursor'), 2);
    const includeMediaUrls = search.get('include_media_urls') === 'true';

    const page = await loadMessagePage(ctx.supabase, { accountId: ctx.accountId, from, to, channel, teamId, cursor, limit, includeMediaUrls });
    await auditExtraction({
      accountId: ctx.accountId,
      keyId: ctx.keyId,
      route: '/api/v1/messages',
      filters: { from, to, channel, team_id: teamId, include_media_urls: includeMediaUrls },
      itemCount: page.items.length,
    });
    return ok(page, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
