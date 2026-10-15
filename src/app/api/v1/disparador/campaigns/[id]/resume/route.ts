// POST /api/v1/disparador/campaigns/[id]/resume — retoma uma campanha pausada (escopo campaigns:write).
// Idempotente por estado: já em execução devolve 200 com changed:false. Guardas que a tela não precisa:
//  - pausada pelo motor (taxa de erro etc.): exige { "acknowledge_auto_pause": true };
//  - template da campanha não aprovado na Meta: 409 (details.code = template_not_approved);
//  - número em qualidade vermelha: 409 sempre (details.code = red_quality) — a confirmação é do proprietário, na tela.
import { ok } from "@/lib/api/v1/respond";
import { controlFailureToApiError, parseResumeBody, readOptionalJsonObject } from "@/lib/api/v1/campaign-control-api";
import { runControlRoute } from "@/lib/api/v1/campaign-control-routes";
import { resumeCampaign } from "@/lib/disparador/campaign-control";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runControlRoute(request, params, "/api/v1/disparador/campaigns/[id]/resume", async ({ accountId, keyId, campaignId, logCtx }) => {
    const { acknowledgeAutoPause } = parseResumeBody(await readOptionalJsonObject(request));
    const result = await resumeCampaign(supabaseAdmin(), { accountId, campaignId, acknowledgeAutoPause });
    if (!result.ok) throw controlFailureToApiError(result);
    if (result.changed) {
      await logAuditEvent({
        accountId,
        eventType: "action",
        resourceType: "campaign",
        resourceId: campaignId,
        action: "campaign.resumed",
        summary: "Campanha retomada pela API",
        metadata: { key_id: keyId, origin: "api", acknowledged_auto_pause: acknowledgeAutoPause },
      });
    }
    return ok({ campaign_id: campaignId, status: result.status, previous_status: result.previous, changed: result.changed }, 200, logCtx);
  });
}
