// GET /api/v1/teams — equipes da conta da chave: { items: [{ id, name, overflow_team_id, member_ids }] } (até 200).
// Escopo conversations:read ou conversations:write. 60/min por chave.
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { enforceCatalogRateLimit } from '@/lib/api/v1/catalog-guard';
import { listTeams } from '@/lib/api/v1/catalogs';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/teams', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ['conversations:read', 'conversations:write']);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceCatalogRateLimit(ctx);
    return ok({ items: await listTeams(ctx.supabase, ctx.accountId) }, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
