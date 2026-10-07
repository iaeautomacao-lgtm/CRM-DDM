import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import {
  buildCurrentSnapshot,
  buildSummaryReport,
  loadActiveConversationFacts,
  loadPeriodConversationFacts,
  loadReportingRoster,
  parseReportQuery,
} from '@/lib/api/v1/reporting';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = {
    method: 'GET',
    route: '/api/v1/reports/operations/summary',
    startedAt: Date.now(),
  };

  try {
    const ctx = await requireApiKey(request, 'reports:read');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;

    const query = parseReportQuery(request.url, true);
    const range = query.range!;
    const [facts, active, roster] = await Promise.all([
      loadPeriodConversationFacts(ctx.supabase, ctx.accountId, range, query.filters),
      loadActiveConversationFacts(ctx.supabase, ctx.accountId, query.filters),
      loadReportingRoster(ctx.supabase, ctx.accountId),
    ]);

    const current = buildCurrentSnapshot(active, roster, query.filters);
    return ok(buildSummaryReport(facts, range, current), 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
