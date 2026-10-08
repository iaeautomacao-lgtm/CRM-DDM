import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { RateLimitError, revertToAuto } from "@/lib/disparador/rate-limits-service";

// POST /api/disparador/rate-limits/[session]/revert-auto — "voltar ao automático" (admin/owner). Corpo opcional: { reason }.
export async function POST(request: Request, { params }: { params: Promise<{ session: string }> }) {
  try {
    const ctx = await requireDisparadorAccess();
    const { session } = await params;
    const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
    const actor = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role };
    return NextResponse.json(await revertToAuto(supabaseAdmin(), actor, session, body?.reason));
  } catch (err) {
    if (err instanceof RateLimitError) return NextResponse.json({ error: err.message }, { status: err.status });
    return toErrorResponse(err);
  }
}
