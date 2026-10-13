import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, payloadTooLarge, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { batchMessagePages, parseBatchPayload } from '@/lib/api/v1/conversations';

export async function POST(request: Request) {
  const log: ApiCallLogContext = { method: 'POST', route: '/api/v1/conversations/messages/batch', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    log.accountId = ctx.accountId; log.keyId = ctx.keyId;
    if (Number(request.headers.get('content-length') || 0) > 32768) {
      throw payloadTooLarge('Batch request cannot exceed 32 KB');
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 32768) throw payloadTooLarge('Batch request cannot exceed 32 KB');
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw badRequest('Invalid JSON'); }
    const payload = parseBatchPayload(body);
    return privateOk(await batchMessagePages(ctx.supabase, ctx.accountId, payload), log);
  } catch (err) { return toApiErrorResponse(err, log); }
}
