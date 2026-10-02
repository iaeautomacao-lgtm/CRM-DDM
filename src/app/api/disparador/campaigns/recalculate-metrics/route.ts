import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { recalculateAllCampaignMetrics } from "@/lib/disparador/recalculateMetrics";

// GET /api/disparador/campaigns/recalculate-metrics
//
// Owner/admin only (requireRole("admin") = hasMinRole >= admin, i.e.
// exactly owner or admin). Recalcula campaign_metrics a partir de
// disp_message_queue para todas as campanhas elegíveis da conta do
// chamador — ver recalculateAllCampaignMetrics.
export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const summary = await recalculateAllCampaignMetrics(ctx.accountId);
    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}
