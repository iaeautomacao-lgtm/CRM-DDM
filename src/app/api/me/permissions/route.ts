// GET /api/me/permissions — contrato de permissões do usuário logado para o front (PRD 20, 20.10, seção 8).
// Qualquer membro autenticado. Derivado de getCurrentAccount().permissions: não decide nada novo.
// Interna (não faz parte da API pública /api/v1): documentada em docs/permissions-api.md.

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { buildMePermissions } from "@/lib/auth/me-permissions";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json(buildMePermissions(ctx), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
