import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/account/admin-client";
import { loadAgreementDashboardMetrics } from "@/lib/dashboard/agreement-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/agreements
 *
 * Owner/admin only, account-scoped KPIs for "Acordo Realizado" (outcome 142).
 * Never exposes underlying conversations, customer data or audit events.
 */
export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const data = await loadAgreementDashboardMetrics(supabaseAdmin(), ctx.accountId);
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
