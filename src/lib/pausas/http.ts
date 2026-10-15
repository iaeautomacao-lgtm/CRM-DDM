import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";

import { PauseApiError } from "./pure";

/** Erro de pausa → `{ error, code, ...extras }`; o resto segue o tratamento padrão do painel (401/403/500). */
export function pauseErrorResponse(err: unknown): NextResponse {
  if (err instanceof PauseApiError) return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
  return toErrorResponse(err);
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
