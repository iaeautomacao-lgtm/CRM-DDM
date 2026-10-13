import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { parseMessageOptions, readMessagePage } from '@/lib/api/v1/conversations';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const log: ApiCallLogContext = { method: 'GET', route: '/api/v1/conversations/[id]/messages', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    log.accountId = ctx.accountId; log.keyId = ctx.keyId;
    const { id } = await params;
    return privateOk(await readMessagePage(
      ctx.supabase, ctx.accountId, id, parseMessageOptions(request.url),
    ), log);
  } catch (err) { return toApiErrorResponse(err, log); }
}
