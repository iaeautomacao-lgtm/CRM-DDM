import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { readConversation } from '@/lib/api/v1/conversations';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const log: ApiCallLogContext = { method: 'GET', route: '/api/v1/conversations/[id]', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    log.accountId = ctx.accountId; log.keyId = ctx.keyId;
    const { id } = await params;
    return privateOk(await readConversation(ctx.supabase, ctx.accountId, id), log);
  } catch (err) { return toApiErrorResponse(err, log); }
}
