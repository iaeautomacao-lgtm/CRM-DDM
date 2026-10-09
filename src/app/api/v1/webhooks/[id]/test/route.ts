// POST /api/v1/webhooks/{id}/test — enfileira um evento `webhook.test` só para este endpoint (valida URL, assinatura e resposta).
// A entrega sai no próximo ciclo do cron; acompanhe em GET /api/v1/webhooks/{id}/deliveries.

import { requireApiKey } from "@/lib/auth/api-context";
import { notFound, ok, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { enqueueTest } from "@/lib/webhooks-out/endpoints";
import { UUID_RE } from "@/lib/webhooks-out/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: "POST", route: "/api/v1/webhooks/[id]/test", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, "webhooks:write");
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const { id } = await params;
    if (!UUID_RE.test(id)) throw notFound("Webhook não encontrado");
    return ok(await enqueueTest(ctx.supabase, ctx.accountId, id), 202, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
