import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { syncCampaignPlannedMetrics } from "@/lib/disparador/campaign-planning";

// POST /api/disparador/campaigns/planned-metrics
// Compatibilidade para campanhas rascunho/agendadas criadas antes de a
// prévia de volume existir. Só recalcula campanhas sem campaign_metrics,
// limitado a 20 por chamada para proteger a VPS.
export async function POST() {
  try {
    const { accountId } = await requireDisparadorAccess();
    const db = supabaseAdmin();

    const { data: campaigns, error } = await db
      .from("campaigns")
      .select("id")
      .eq("account_id", accountId)
      .in("status", ["rascunho", "agendado"])
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;

    if (!campaigns?.length) return NextResponse.json({ updated: 0 });

    const ids = campaigns.map((c) => c.id);
    const { data: existing, error: existingError } = await db
      .from("campaign_metrics")
      .select("campaign_id")
      .in("campaign_id", ids);
    if (existingError) throw existingError;

    const have = new Set((existing ?? []).map((row) => row.campaign_id));
    let updated = 0;
    const errors: string[] = [];

    // Sequencial de propósito: loadCampaignAudience pode paginar a base
    // inteira; não multiplicamos essas leituras em paralelo na VPS.
    for (const campaign of campaigns) {
      if (have.has(campaign.id)) continue;
      const result = await syncCampaignPlannedMetrics(db, accountId, campaign.id);
      if (result.ok) updated++;
      else errors.push(result.error);
    }

    return NextResponse.json({ updated, failed: errors.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
