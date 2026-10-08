// GET /api/account/permission-catalog — catálogo de permissões agrupado, somente leitura (PRD 20, 20.10, seção 8).
// Permissão: `roles.manage` ou `members.view` (hoje todos os papéis têm members.view). Interna: docs/permissions-api.md.

import { NextResponse } from "next/server";

import { ForbiddenError, getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { buildPermissionCatalogGroups } from "@/lib/auth/me-permissions";
import { can } from "@/lib/auth/permissions";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    if (!can(ctx, "roles.manage") && !can(ctx, "members.view")) {
      throw new ForbiddenError("Você não tem permissão para ver o catálogo de permissões.");
    }
    return NextResponse.json(
      { groups: buildPermissionCatalogGroups() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
