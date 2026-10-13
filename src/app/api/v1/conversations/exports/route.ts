import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, payloadTooLarge, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { enqueueConversationExport, rejectOversizeBody } from '@/lib/api/v1/conversation-exports';

// Scope deliberately stronger than conversations:read. Only queues work;
// cron (authenticated separately) generates the private NDJSON file.
export async function POST(request: Request) {
  const log: ApiCallLogContext = { method: 'POST', route: '/api/v1/conversations/exports', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:export');
    log.accountId = ctx.accountId; log.keyId = ctx.keyId;
    if (Number(request.headers.get('content-length') || 0) > 32768) {
      throw payloadTooLarge('Export request too large');
    }
    const raw = await request.text();
    rejectOversizeBody(raw);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw badRequest('Invalid JSON'); }
    const job = await enqueueConversationExport(ctx.supabase, ctx.accountId, ctx.keyId, body);
    return privateOk(job, log, 202);
  } catch (err) { return toApiErrorResponse(err, log); }
}
