import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import {
  buildCurrentSnapshot,
  loadActiveConversationFacts,
  loadReportingRoster,
  parseReportQuery,
} from '@/lib/api/v1/reporting';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = {
    method: 'GET',
    route: '/api/v1/reports/operations/current',
    startedAt: Date.now(),
  };

  try {
    const ctx = await requireApiKey(request, 'reports:read');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;

    const { filters } = parseReportQuery(request.url, false);
    const [active, roster] = await Promise.all([
      loadActiveConversationFacts(ctx.supabase, ctx.accountId, filters),
      loadReportingRoster(ctx.supabase, ctx.accountId),
    ]);

    return ok(buildCurrentSnapshot(active, roster, filters), 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
