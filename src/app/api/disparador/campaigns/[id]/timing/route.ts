import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import {
  computeCampaignTiming,
  type CampaignStatusAuditEvent,
} from "@/lib/disparador/campaign-timing";

// GET /api/disparador/campaigns/[id]/timing
// Reconstrói o tempo real da campanha a partir de audit_logs. Não usa
// updated_at-agendamento: esse intervalo inclui as pausas e infla a métrica.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireDisparadorAccess();
    const { id } = await params;
    const db = supabaseAdmin();

    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .select("id,status,updated_at,janela_inicio,janela_fim,dias_envio")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();

    if (campaignError) throw campaignError;
    if (!campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    const { data: events, error: auditError } = await db
      .from("audit_logs")
      .select("created_at,changes")
      .eq("account_id", accountId)
      .eq("resource_type", "campaign")
      .eq("resource_id", id)
      .eq("action", "campaign.status_changed")
      .order("created_at", { ascending: true })
      .limit(1000);

    if (auditError) throw auditError;

    const timing = computeCampaignTiming({
      currentStatus: campaign.status,
      updatedAt: campaign.updated_at,
      janela: {
        inicio: campaign.janela_inicio,
        fim: campaign.janela_fim,
        dias: campaign.dias_envio,
      },
      events: (events ?? []) as CampaignStatusAuditEvent[],
    });

    return NextResponse.json({ data: timing });
  } catch (err) {
    return toErrorResponse(err);
  }
}
