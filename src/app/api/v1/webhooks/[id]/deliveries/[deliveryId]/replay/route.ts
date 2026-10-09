// POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/replay — recoloca na fila uma entrega `dead` (zera as tentativas).
// 409 se a entrega não estiver `dead`; 404 se o webhook não for da conta.

import { requireApiKey } from "@/lib/auth/api-context";
import { notFound, ok, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { replayDelivery } from "@/lib/webhooks-out/endpoints";
import { UUID_RE } from "@/lib/webhooks-out/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; deliveryId: string }> }) {
  const logCtx: ApiCallLogContext = { method: "POST", route: "/api/v1/webhooks/[id]/deliveries/[deliveryId]/replay", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, "webhooks:write");
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const { id, deliveryId } = await params;
    if (!UUID_RE.test(id) || !UUID_RE.test(deliveryId)) throw notFound("Webhook ou entrega não encontrados");
    await replayDelivery(ctx.supabase, ctx.accountId, id, deliveryId);
    return ok({ id: deliveryId, state: "pending" }, 202, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
