// ============================================================
// /api/account/roles   (PRD 20 + TASK5 — cargos, migrations 312/313/318)
//
//   GET  — cargos de sistema + personalizados, com permissões efetivas, padrão, membros, limite e o que eu posso fazer
//          (editable/assignable/deletable/customized/level).                                       members.view
//   POST — cria um cargo personalizado { name, description?, permissions[] }.                         roles.manage (admin e acima)
//
// Erros: 400 {error, code:'invalid'|'invalid_permissions', errors?} · 403 {code:'forbidden'|'escalation'(+permissions)|'role_level'}
//        · 409 {code:'name_taken'|'limit_reached'} · 503.
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { createCustomRole, listRoles, parseRoleInput } from "@/lib/roles/custom-roles";
import { NO_STORE, roleRouteError } from "@/lib/roles/http";

export async function GET() {
  try {
    const ctx = await requirePermission("members.view");
    return NextResponse.json(await listRoles(supabaseAdmin(), ctx.accountId, ctx), { headers: NO_STORE });
  } catch (err) {
    return roleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePermission("roles.manage");
    const limit = await checkRateLimit(`admin:roles:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const input = parseRoleInput(await request.json().catch(() => null), "create");
    const created = await createCustomRole(supabaseAdmin(), { accountId: ctx.accountId, actorId: ctx.userId, ...input });
    return NextResponse.json({ ok: true, ...created }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return roleRouteError(err);
  }
}
