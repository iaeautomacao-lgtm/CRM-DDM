// Corpo comum das rotas POST de controle de campanha da API pública (pause, resume, cancel, recipients/remove): autentica com
// campaigns:write, aplica o limite de 30/min, valida o id, roda a ação e devolve o envelope. Cada rota só passa o que é específico.
import { requireApiKey } from '@/lib/auth/api-context';
import { notFound, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/extract';
import { enforceControlRateLimit } from '@/lib/api/v1/campaign-control-api';
import type { NextResponse } from 'next/server';

export interface ControlRouteContext {
  accountId: string;
  keyId: string;
  campaignId: string;
  logCtx: ApiCallLogContext;
}

export async function runControlRoute(
  request: Request,
  params: Promise<{ id: string }>,
  route: string,
  handler: (ctx: ControlRouteContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const { id: campaignId } = await params;
  const logCtx: ApiCallLogContext = { method: 'POST', route, startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'campaigns:write');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceControlRateLimit(ctx);
    if (!isUuid(campaignId)) throw notFound('Campanha não encontrada');
    return await handler({ accountId: ctx.accountId, keyId: ctx.keyId, campaignId, logCtx });
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
