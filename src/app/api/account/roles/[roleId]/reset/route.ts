// ============================================================
// POST /api/account/roles/{roleId}/reset   (TASK5 — migration 318)      roles.manage (admin e acima; só cargos ABAIXO do seu)
//
// Restaura o padrão de um cargo de SISTEMA nesta organização (apaga o ajuste). O account_role dos membros volta ao do
// cargo. → {ok, id, compat_role, members_updated, customized: false}. Personalizado → 400; outra organização → 404.
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission } from "@/lib/auth/account";
import { isUuid } from "@/lib/auth/sessions";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { CustomRoleError, resetSystemRolePermissions, roleKind } from "@/lib/roles/custom-roles";
import { NO_STORE, roleRouteError } from "@/lib/roles/http";

export async function POST(_request: Request, { params }: { params: Promise<{ roleId: string }> }) {
  try {
    const ctx = await requirePermission("roles.manage");
    const { roleId } = await params;
    if (!isUuid(roleId)) {
      return NextResponse.json({ error: "Cargo não encontrado.", code: "not_found" }, { status: 404, headers: NO_STORE });
    }
    const limit = await checkRateLimit(`admin:roles:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const db = supabaseAdmin();
    const kind = await roleKind(db, ctx.accountId, roleId);
    if (!kind) return NextResponse.json({ error: "Cargo não encontrado.", code: "not_found" }, { status: 404, headers: NO_STORE });
    if (kind !== "system") throw new CustomRoleError("Só cargo de sistema tem padrão para restaurar.", 400, "invalid");

    const result = await resetSystemRolePermissions(db, { accountId: ctx.accountId, actorId: ctx.userId, roleId });
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return roleRouteError(err);
  }
}
