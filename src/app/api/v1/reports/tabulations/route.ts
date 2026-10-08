import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import {
  buildTabulationsReport,
  loadOutcomeTags,
  loadPeriodConversationFacts,
  parseReportQuery,
} from '@/lib/api/v1/reporting';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = {
    method: 'GET',
    route: '/api/v1/reports/tabulations',
    startedAt: Date.now(),
  };

  try {
    const ctx = await requireApiKey(request, 'reports:read');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;

    const query = parseReportQuery(request.url, true);
    const range = query.range!;
    const [facts, tags] = await Promise.all([
      loadPeriodConversationFacts(ctx.supabase, ctx.accountId, range, query.filters),
      loadOutcomeTags(ctx.supabase, ctx.accountId),
    ]);

    return ok(
      {
        generated_at: new Date().toISOString(),
        period: { from: range.fromDate, to: range.toDate, timezone: 'America/Sao_Paulo' },
        ...buildTabulationsReport(facts, range, tags),
      },
      200,
      logCtx,
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
