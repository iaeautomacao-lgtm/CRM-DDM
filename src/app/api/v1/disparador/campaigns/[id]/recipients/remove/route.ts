// POST /api/v1/disparador/campaigns/[id]/recipients/remove — tira destinatários AINDA NÃO ENVIADOS da campanha (ex.: o cliente pagou).
// Escopo campaigns:write. Corpo: { recipients: [{ phone?, cpf?, reference? }], reason?: "paid" | "agreement" | "other" } — 1 a 500 itens.
// Idempotente (repetir devolve already_removed). NÃO é opt-out: a blacklist não é tocada. Item já enviado não se desfaz (already_sent);
// em envio agora (in_flight) vale repetir depois. Entradas inválidas voltam como "invalid" sem derrubar as demais. CPF nunca é devolvido.
import { ok, notFound } from "@/lib/api/v1/respond";
import { parseRemoveBody, readOptionalJsonObject, removeRecipients } from "@/lib/api/v1/campaign-control-api";
import { runControlRoute } from "@/lib/api/v1/campaign-control-routes";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runControlRoute(request, params, "/api/v1/disparador/campaigns/[id]/recipients/remove", async ({ accountId, keyId, campaignId, logCtx }) => {
    const parsed = parseRemoveBody(await readOptionalJsonObject(request));
    const response = await removeRecipients(supabaseAdmin(), { accountId, campaignId, parsed });
    if (!response) throw notFound("Campanha não encontrada");
    if (response.items_removed > 0) {
      // Só contagens: nunca telefone, CPF ou referência no log de auditoria.
      await logAuditEvent({
        accountId,
        eventType: "action",
        resourceType: "campaign",
        resourceId: campaignId,
        action: "campaign.recipients_removed",
        summary: `Pela API, ${response.items_removed} destinatário(s) removido(s) da campanha (${parsed.reason})`,
        metadata: { key_id: keyId, origin: "api", reason: parsed.reason, removed: response.items_removed, requested: parsed.entries.length },
      });
    }
    return ok(response, 200, logCtx);
  });
}
