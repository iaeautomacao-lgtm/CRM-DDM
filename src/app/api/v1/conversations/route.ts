import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { listConversations, parseListOptions } from '@/lib/api/v1/conversations';

/** Returns metadata only; read /{id}/messages for a full transcript. */
export async function GET(request: Request) {
  const log: ApiCallLogContext = { method: 'GET', route: '/api/v1/conversations', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    log.accountId = ctx.accountId; log.keyId = ctx.keyId;
    return privateOk(await listConversations(
      ctx.supabase, ctx.accountId, parseListOptions(request.url),
    ), log);
  } catch (err) { return toApiErrorResponse(err, log); }
}
