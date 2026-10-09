// ============================================================
// /api/v1/webhooks — webhooks de SAÍDA assinados (PRD 15, 15.14).
//
//   GET  → lista os endpoints da conta (webhooks:read ou webhooks:write). O segredo NUNCA volta.
//   POST → cadastra um endpoint (webhooks:write): { url (https, público), events[], description? }. O segredo `whsec_…`
//          é devolvido UMA vez, na criação (e em /rotate-secret); guarde-o para validar o X-CRM-Signature.
//
// Eventos, assinatura, retry e dead-letter: ver o guia no OpenAPI (`/api/v1/openapi.json`).
// ============================================================

import { requireApiKey } from "@/lib/auth/api-context";
import { ok, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { createEndpoint, listEndpoints } from "@/lib/webhooks-out/endpoints";
import { readJsonObject } from "@/lib/webhooks-out/http";

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = { method: "GET", route: "/api/v1/webhooks", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ["webhooks:read", "webhooks:write"]);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    return ok(await listEndpoints(ctx.supabase, ctx.accountId), 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}

export async function POST(request: Request) {
  const logCtx: ApiCallLogContext = { method: "POST", route: "/api/v1/webhooks", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, "webhooks:write");
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const body = await readJsonObject(request);
    const created = await createEndpoint(ctx.supabase, {
      accountId: ctx.accountId,
      keyId: ctx.keyId,
      url: body.url,
      events: body.events,
      description: body.description,
    });
    return ok(created, 201, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
