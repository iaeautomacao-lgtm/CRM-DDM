// POST /api/v1/disparador/campaigns/[id]/cancel — cancela (encerra) uma campanha (escopo campaigns:write). IRREVERSÍVEL:
// exige { "confirm": true }. Itens agendados/pausados viram "cancelado"; itens já em envio seguem. Idempotente: já encerrada = 200 changed:false.
// Só cancela campanha em execução, pausada ou agendada (rascunho/preparando = 409).
import { ok } from "@/lib/api/v1/respond";
import { controlFailureToApiError, parseCancelBody, readOptionalJsonObject } from "@/lib/api/v1/campaign-control-api";
import { runControlRoute } from "@/lib/api/v1/campaign-control-routes";
import { cancelCampaign } from "@/lib/disparador/campaign-control";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runControlRoute(request, params, "/api/v1/disparador/campaigns/[id]/cancel", async ({ accountId, keyId, campaignId, logCtx }) => {
    parseCancelBody(await readOptionalJsonObject(request));
    const result = await cancelCampaign(supabaseAdmin(), { accountId, campaignId, motive: "cancelled_api" });
    if (!result.ok) throw controlFailureToApiError(result);
    if (result.changed) {
      await logAuditEvent({
        accountId,
        eventType: "action",
        resourceType: "campaign",
        resourceId: campaignId,
        action: "campaign.cancelled",
        summary: "Campanha cancelada pela API",
        metadata: { key_id: keyId, origin: "api", previous_status: result.previous },
      });
    }
    return ok(
      { campaign_id: campaignId, status: result.status, previous_status: result.previous, changed: result.changed, items_pending_move: result.itemsPendingMove },
      200,
      logCtx,
    );
  });
}
