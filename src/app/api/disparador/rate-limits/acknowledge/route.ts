import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { acknowledgeHistory, RateLimitError } from "@/lib/disparador/rate-limits-service";

// POST /api/disparador/rate-limits/acknowledge — { ids: string[] } reconhece avisos de queda de qualidade (admin/owner).
export async function POST(request: Request) {
  try {
    const ctx = await requireDisparadorAccess();
    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
    const actor = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role };
    return NextResponse.json(await acknowledgeHistory(supabaseAdmin(), actor, body?.ids));
  } catch (err) {
    if (err instanceof RateLimitError) return NextResponse.json({ error: err.message }, { status: err.status });
    return toErrorResponse(err);
  }
}
