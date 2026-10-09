// ============================================================
// POST /api/account/members/{userId}/status   { active: boolean }   — members.manage (admin+)
//
// Desativa ou reativa um membro da organização (TASK3, migration 311). Nunca o proprietário nem a si mesmo (o banco
// recusa com 403). Desativar apaga as sessões, tira a presença, bane no Supabase Auth e audita; reativar desfaz.
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { isUuid } from "@/lib/auth/sessions";
import { MemberStatusError, setMemberActive } from "@/lib/members/member-status";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const ctx = await requirePermission("members.manage");
    const { userId } = await params;
    if (!isUuid(userId)) return NextResponse.json({ error: "Membro não encontrado." }, { status: 404, headers: NO_STORE });
    if (userId === ctx.userId) {
      return NextResponse.json({ error: "Você não pode desativar ou reativar a si mesmo." }, { status: 403, headers: NO_STORE });
    }

    const limit = await checkRateLimit(`admin:memberStatus:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { active?: unknown } | null;
    if (!body || typeof body.active !== "boolean") {
      return NextResponse.json({ error: "Informe 'active' (true ou false)." }, { status: 400, headers: NO_STORE });
    }

    const admin = supabaseAdmin();
    const result = await setMemberActive(
      { db: admin, auth: admin as unknown as Parameters<typeof setMemberActive>[0]["auth"] },
      { accountId: ctx.accountId, actorId: ctx.userId, targetId: userId, active: body.active },
    );
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof MemberStatusError) return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    return toErrorResponse(err);
  }
}
