import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { privateOk } from '@/lib/api/v1/conversation-response';
import { getConversationExport, validateExportJobId } from '@/lib/api/v1/conversation-exports';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const log: ApiCallLogContext = { method: 'GET', route: '/api/v1/conversations/exports/[id]', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'conversations:export');
    log.accountId = ctx.accountId; log.keyId = ctx.keyId;
    const { id } = await params;
    return privateOk(await getConversationExport(
      ctx.supabase, ctx.accountId, ctx.keyId, validateExportJobId(id),
    ), log);
  } catch (err) { return toApiErrorResponse(err, log); }
}
