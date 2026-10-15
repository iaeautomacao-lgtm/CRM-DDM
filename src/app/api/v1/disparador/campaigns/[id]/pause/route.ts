// POST /api/v1/disparador/campaigns/[id]/pause — pausa uma campanha em execução (escopo campaigns:write).
// Idempotente por estado: já pausada devolve 200 com changed:false. Estado incompatível = 409. Itens já em envio não são tocados.
// Corpo opcional: { "reason": "texto até 200" } (aparece no painel e no detalhe). 30/min por chave, além dos 120/min gerais.
import { ok } from "@/lib/api/v1/respond";
import { controlFailureToApiError, parsePauseBody, readOptionalJsonObject } from "@/lib/api/v1/campaign-control-api";
import { runControlRoute } from "@/lib/api/v1/campaign-control-routes";
import { pauseCampaign } from "@/lib/disparador/campaign-control";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runControlRoute(request, params, "/api/v1/disparador/campaigns/[id]/pause", async ({ accountId, keyId, campaignId, logCtx }) => {
    const { reason } = parsePauseBody(await readOptionalJsonObject(request));
    const result = await pauseCampaign(supabaseAdmin(), { accountId, campaignId, reason });
    if (!result.ok) throw controlFailureToApiError(result);
    if (result.changed) {
      await logAuditEvent({
        accountId,
        eventType: "action",
        resourceType: "campaign",
        resourceId: campaignId,
        action: "campaign.paused",
        summary: "Campanha pausada pela API",
        metadata: { key_id: keyId, origin: "api", has_reason: !!reason },
      });
    }
    return ok(
      { campaign_id: campaignId, status: result.status, previous_status: result.previous, changed: result.changed, items_pending_move: result.itemsPendingMove },
      200,
      logCtx,
    );
  });
}
