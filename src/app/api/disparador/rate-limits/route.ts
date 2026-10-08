import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { listRateLimits, RateLimitError, setManualRate, updatePolicy } from "@/lib/disparador/rate-limits-service";

// GET  /api/disparador/rate-limits → política, saúde e limite/s efetivo por número Meta (admin/owner).
// PUT  /api/disparador/rate-limits → { session_id, rate_per_second, reason, force_above_quality? } sobrescreve um número;
//                                    ou { policy: {...}, reason } (só owner) altera a política da conta.

function handle(err: unknown) {
  if (err instanceof RateLimitError) return NextResponse.json({ error: err.message }, { status: err.status });
  return toErrorResponse(err);
}

export async function GET() {
  try {
    const ctx = await requireDisparadorAccess();
    return NextResponse.json(await listRateLimits(supabaseAdmin(), ctx.accountId));
  } catch (err) {
    return handle(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireDisparadorAccess();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Corpo inválido." }, { status: 400 });
    const actor = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role };
    if (body.policy && typeof body.policy === "object") {
      return NextResponse.json(await updatePolicy(supabaseAdmin(), actor, body.policy as Record<string, unknown>, body.reason));
    }
    return NextResponse.json(
      await setManualRate(supabaseAdmin(), actor, {
        session_id: body.session_id,
        rate_per_second: body.rate_per_second,
        reason: body.reason,
        force_above_quality: body.force_above_quality,
      }),
    );
  } catch (err) {
    return handle(err);
  }
}
