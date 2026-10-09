// GET /api/v1/webhooks/{id}/deliveries?state=&cursor=&limit= — histórico de entregas do endpoint, mais recentes primeiro
// (keyset). `state=dead` lista o que esgotou as 12 tentativas (reenvie com POST …/deliveries/{deliveryId}/replay).
// Nunca devolve o corpo enviado nem o segredo: só estado, tentativas, HTTP da última tentativa e um erro curto.

import { requireApiKey } from "@/lib/auth/api-context";
import { notFound, ok, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { listDeliveries } from "@/lib/webhooks-out/endpoints";
import { UUID_RE } from "@/lib/webhooks-out/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: "GET", route: "/api/v1/webhooks/[id]/deliveries", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ["webhooks:read", "webhooks:write"]);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const { id } = await params;
    if (!UUID_RE.test(id)) throw notFound("Webhook não encontrado");
    const url = new URL(request.url);
    const limit = url.searchParams.get("limit");
    const result = await listDeliveries(ctx.supabase, ctx.accountId, id, {
      state: url.searchParams.get("state"),
      cursor: url.searchParams.get("cursor"),
      limit: limit ? Number.parseInt(limit, 10) || undefined : undefined,
    });
    return ok(result, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
