// ============================================================
// /api/account/roles/{roleId}   (PRD 20 — papel personalizado, migration 313)      roles.manage (só o proprietário)
//
//   PATCH  — { name?, description? (null limpa), permissions? }. Trocar permissões recalcula o compat_role e o
//            account_role dos membros do papel (eles continuam no papel). → {ok, id, compat_role, previous_compat_role, members_updated}
//   DELETE — apaga o papel. Em uso → 409 {code:'role_in_use', members}. Papel de sistema/outra organização → 404.
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission } from "@/lib/auth/account";
import { isUuid } from "@/lib/auth/sessions";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { deleteCustomRole, parseRoleInput, updateCustomRole } from "@/lib/roles/custom-roles";
import { NO_STORE, roleRouteError } from "@/lib/roles/http";

type Params = { params: Promise<{ roleId: string }> };

const notFound = () => NextResponse.json({ error: "Papel não encontrado.", code: "not_found" }, { status: 404, headers: NO_STORE });

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requirePermission("roles.manage");
    const { roleId } = await params;
    if (!isUuid(roleId)) return notFound();
    const limit = await checkRateLimit(`admin:roles:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const input = parseRoleInput(await request.json().catch(() => null), "update");
    const result = await updateCustomRole(supabaseAdmin(), { accountId: ctx.accountId, actorId: ctx.userId, roleId, ...input });
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return roleRouteError(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requirePermission("roles.manage");
    const { roleId } = await params;
    if (!isUuid(roleId)) return notFound();
    const limit = await checkRateLimit(`admin:roles:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const result = await deleteCustomRole(supabaseAdmin(), { accountId: ctx.accountId, actorId: ctx.userId, roleId });
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return roleRouteError(err);
  }
}
