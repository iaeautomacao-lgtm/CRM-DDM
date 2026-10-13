import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { listWahaRates, setWahaRate, WahaRateError } from "@/lib/disparador/waha-rate";

// GET /api/disparador/waha-rate → ritmo (mensagens por segundo) de cada sessão WAHA da conta, com o padrão e a faixa permitida (admin/owner).
// PUT /api/disparador/waha-rate → { session_id, rate_per_second, reason } define o ritmo de UMA sessão (0,1 a 20/s); rate_per_second: null
//                                 volta ao padrão (1/s). Exige a permissão campaigns.rate_limit, motivo e grava auditoria. Vale no próximo tick.
// Só WAHA: a Meta segue a regra por qualidade em /api/disparador/rate-limits.

function handle(err: unknown) {
  if (err instanceof WahaRateError) return NextResponse.json({ error: err.message }, { status: err.status });
  return toErrorResponse(err);
}

export async function GET() {
  try {
    const ctx = await requireDisparadorAccess("campaigns.rate_limit");
    return NextResponse.json(await listWahaRates(supabaseAdmin(), ctx.accountId));
  } catch (err) {
    return handle(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireDisparadorAccess("campaigns.rate_limit");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Corpo inválido." }, { status: 400 });
    const actor = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role, permissions: ctx.permissions };
    return NextResponse.json(
      await setWahaRate(supabaseAdmin(), actor, {
        session_id: body.session_id,
        rate_per_second: body.rate_per_second,
        reason: body.reason,
      }),
    );
  } catch (err) {
    return handle(err);
  }
}
