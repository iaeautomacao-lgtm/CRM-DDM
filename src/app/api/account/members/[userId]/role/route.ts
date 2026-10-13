// ============================================================
// PUT /api/account/members/{userId}/role   { role_id }   (PRD 20 — papel personalizado, migration 313)
//
// Atribui um papel (personalizado da organização ou de sistema, menos proprietário) a um membro. roles.manage: só o
// proprietário. Nunca o proprietário nem a si mesmo (403). O account_role do membro vira o compat_role do papel.
// → {ok, previous_role_id, role_id, compat_role}. A troca entre papéis de sistema segue também pelo PATCH de membros (admin).
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission } from "@/lib/auth/account";
import { isUuid } from "@/lib/auth/sessions";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { assignMemberRole } from "@/lib/roles/custom-roles";
import { NO_STORE, roleRouteError } from "@/lib/roles/http";

export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const ctx = await requirePermission("roles.manage");
    const { userId } = await params;
    if (!isUuid(userId)) {
      return NextResponse.json({ error: "Membro não encontrado.", code: "not_found" }, { status: 404, headers: NO_STORE });
    }
    if (userId === ctx.userId) {
      return NextResponse.json({ error: "Você não pode mudar o próprio papel.", code: "forbidden" }, { status: 403, headers: NO_STORE });
    }
    const limit = await checkRateLimit(`admin:memberRole:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { role_id?: unknown } | null;
    if (!body || !isUuid(body.role_id)) {
      return NextResponse.json({ error: "Informe 'role_id' (id do papel).", code: "invalid" }, { status: 400, headers: NO_STORE });
    }

    const result = await assignMemberRole(supabaseAdmin(), {
      accountId: ctx.accountId,
      actorId: ctx.userId,
      targetId: userId,
      roleId: body.role_id,
    });
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return roleRouteError(err);
  }
}
