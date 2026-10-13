import "server-only";
// Resposta HTTP dos erros de papel personalizado (rotas /api/account/roles e /api/account/members/{id}/role).
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { CustomRoleError } from "./custom-roles";

export const NO_STORE = { "Cache-Control": "no-store" };

export function roleRouteError(err: unknown): NextResponse {
  if (err instanceof CustomRoleError) {
    return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status, headers: NO_STORE });
  }
  return toErrorResponse(err);
}
