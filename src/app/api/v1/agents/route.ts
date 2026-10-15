// GET /api/v1/agents[?team_id&role&status&limit&cursor] — atendentes ativos da conta da chave (operador, supervisor, admin, proprietário) com
// status (online | away | offline, mesma régua de presença do painel) e pausa atual. SÓ cadastro e status: sem métricas, sem e-mail, sem telefone.
// Escopo conversations:read ou conversations:write. 60/min por chave. Ordem (created_at, id) crescente com cursor; limit 1..200 (padrão 100).
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { enforceCatalogRateLimit } from '@/lib/api/v1/catalog-guard';
import { listAgents, parseAgentsQuery } from '@/lib/api/v1/catalogs';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/agents', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ['conversations:read', 'conversations:write']);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceCatalogRateLimit(ctx);
    const q = parseAgentsQuery(new URL(request.url).searchParams);
    return ok(await listAgents(ctx.supabase, ctx.accountId, q), 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
