// /api/v1/webhooks/{id} — lê, altera (url, events, description, status active|paused) ou apaga um endpoint (PRD 15, 15.14).
// Só enxerga endpoints da própria conta: de outra conta (ou id inválido) devolve 404.

import { requireApiKey } from "@/lib/auth/api-context";
import { notFound, ok, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { deleteEndpoint, getEndpoint, updateEndpoint } from "@/lib/webhooks-out/endpoints";
import { readJsonObject, UUID_RE } from "@/lib/webhooks-out/http";

type Params = { params: Promise<{ id: string }> };
type Ctx = Awaited<ReturnType<typeof requireApiKey>>;

async function handle(
  request: Request,
  { params }: Params,
  method: "GET" | "PATCH" | "DELETE",
  scopes: ("webhooks:read" | "webhooks:write")[],
  run: (ctx: Ctx, id: string, logCtx: ApiCallLogContext) => Promise<Response>,
) {
  const logCtx: ApiCallLogContext = { method, route: "/api/v1/webhooks/[id]", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, scopes);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const { id } = await params;
    if (!UUID_RE.test(id)) throw notFound("Webhook não encontrado");
    return await run(ctx, id, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}

export function GET(request: Request, context: Params) {
  return handle(request, context, "GET", ["webhooks:read", "webhooks:write"], async (ctx, id, logCtx) =>
    ok(await getEndpoint(ctx.supabase, ctx.accountId, id), 200, logCtx),
  );
}

export function PATCH(request: Request, context: Params) {
  return handle(request, context, "PATCH", ["webhooks:write"], async (ctx, id, logCtx) => {
    const body = await readJsonObject(request);
    return ok(await updateEndpoint(ctx.supabase, ctx.accountId, id, body), 200, logCtx);
  });
}

export function DELETE(request: Request, context: Params) {
  return handle(request, context, "DELETE", ["webhooks:write"], async (ctx, id, logCtx) => {
    await deleteEndpoint(ctx.supabase, ctx.accountId, id);
    return ok({ id, deleted: true }, 200, logCtx);
  });
}
