import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadCampaignStatusCounts } from "@/lib/disparador/campaign-status-counts";
import { isUuid } from "@/lib/disparador/campaign-payload";
import { loadCampaignFunnel } from "@/lib/utmpay/stats";

export const dynamic = "force-dynamic";

// GET /api/disparador/campaigns/[id]/funil — funil da campanha (UTMpay; decisões do dono, 14/10). Contrato: prd-v2/contrato-api-utmpay-crm.md.
//   → { available, tracking, entregues, links, clicou, fechou, pagou, taxas:{clicou,fechou,pagou}, por_atribuicao:{fechou,pagou}, por_atendente:[…] }
// fechou = etapa payment_start; pagou = etapa paid CONFIRMADA na API DDM. Taxas = contagem ÷ entregues (entregue + lido). Mesmo papel do Disparador.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireDisparadorAccess();
    const { id: campaignId } = await params;
    if (!isUuid(campaignId)) return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });

    const db = supabaseAdmin();
    const { data: campaign } = await db.from("campaigns").select("id").eq("id", campaignId).eq("account_id", accountId).maybeSingle();
    if (!campaign) return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });

    const counts = await loadCampaignStatusCounts(db, campaignId);
    const delivered = (counts?.entregue ?? 0) + (counts?.lido ?? 0);
    return NextResponse.json(await loadCampaignFunnel(db, accountId, campaignId, delivered));
  } catch (err) {
    return toErrorResponse(err);
  }
}
