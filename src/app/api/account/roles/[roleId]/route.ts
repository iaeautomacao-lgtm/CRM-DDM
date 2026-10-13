// ============================================================
// /api/account/roles/{roleId}   (PRD 20 + TASK5 — migrations 313/318)      roles.manage (admin e acima; só cargos ABAIXO do seu)
//
//   PATCH  — personalizado: { name?, description? (null limpa), permissions? }.
//            sistema: { permissions } — ajuste DESTA organização (nome/descrição de cargo de sistema = 400).
//            Trocar permissões recalcula o compat_role e o account_role dos membros (eles continuam no cargo).
//            → {ok, id, compat_role, previous_compat_role, members_updated[, customized]}
//   DELETE — apaga o personalizado. Em uso → 409 {code:'role_in_use', members}. Cargo de sistema/outra organização → 404.
//   Restaurar o padrão de um cargo de sistema: POST /api/account/roles/{roleId}/reset.
//   403: {code:'escalation', permissions} (concedeu o que não tem) · {code:'role_level'} (cargo do seu nível ou acima).
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission } from "@/lib/auth/account";
import { isUuid } from "@/lib/auth/sessions";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import {
  CustomRoleError,
  deleteCustomRole,
  parseRoleInput,
  roleKind,
  setSystemRolePermissions,
  updateCustomRole,
} from "@/lib/roles/custom-roles";
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
    const db = supabaseAdmin();
    const kind = await roleKind(db, ctx.accountId, roleId);
    if (!kind) return notFound();
    if (kind === "system") {
      if (input.name !== undefined || input.description !== undefined || !input.permissions) {
        throw new CustomRoleError("Cargo de sistema: só as permissões podem ser ajustadas.", 400, "invalid");
      }
      const result = await setSystemRolePermissions(db, {
        accountId: ctx.accountId,
        actorId: ctx.userId,
        roleId,
        permissions: input.permissions,
      });
      return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
    }
    const result = await updateCustomRole(db, { accountId: ctx.accountId, actorId: ctx.userId, roleId, ...input });
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
