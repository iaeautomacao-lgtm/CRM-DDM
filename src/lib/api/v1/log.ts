// ============================================================
// Logging de chamadas à API pública (/api/v1/*) em wacrm.system_logs
// (source: 'api_v1'), exibidas na aba "Eventos" de /ddm-logs.
//
// Chamado a partir de `ok()`/`toApiErrorResponse()` (src/lib/api/v1/
// respond.ts) — cada rota /api/v1 monta um ApiCallLogContext logo após
// requireApiKey() e passa adiante nos dois pontos de retorno, então uma
// única linha é gravada por request, cobrindo tanto sucesso quanto erro
// de negócio. Falhas de autenticação (401/403/429), que ocorrem antes
// da rota ter um ctx, são cobertas via o campo accountId/keyId opcional
// no próprio ApiError (ver forbidden()/rateLimited() em respond.ts).
// ============================================================

import { writeLog } from '@/lib/logger';

export interface ApiCallLogContext {
  method: string;
  route: string;
  startedAt: number;
  accountId?: string | null;
  keyId?: string | null;
}

export function logPublicApiCall(
  ctx: ApiCallLogContext,
  status: number,
  code: string | null
): void {
  const duration_ms = Date.now() - ctx.startedAt;
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

  // Fire-and-forget — writeLog nunca lança, então isso não pode afetar
  // a resposta já pronta para o caller da API pública.
  void writeLog({
    account_id: ctx.accountId ?? null,
    level,
    source: 'api_v1',
    event: 'public_api_call',
    message: `${ctx.method} ${ctx.route} -> ${status}`,
    payload: {
      method: ctx.method,
      route: ctx.route,
      status,
      code,
      key_id: ctx.keyId ?? null,
      duration_ms,
    },
  });
}
