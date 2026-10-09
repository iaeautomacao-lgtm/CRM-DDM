// POST /api/v1/webhooks/{id}/rotate-secret — gera um novo segredo (devolvido UMA vez). O anterior deixa de valer na hora.

import { requireApiKey } from "@/lib/auth/api-context";
import { notFound, ok, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { rotateSecret } from "@/lib/webhooks-out/endpoints";
import { UUID_RE } from "@/lib/webhooks-out/http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: "POST", route: "/api/v1/webhooks/[id]/rotate-secret", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, "webhooks:write");
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const { id } = await params;
    if (!UUID_RE.test(id)) throw notFound("Webhook não encontrado");
    return ok({ id, ...(await rotateSecret(ctx.supabase, ctx.accountId, id)) }, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
