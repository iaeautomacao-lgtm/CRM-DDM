import { NextResponse } from "next/server";

import { clientIp } from "@/lib/audit/context";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { formatCspViolation, sanitizeCspReports } from "@/lib/security/csp-report";
import { readCappedBody } from "@/lib/security/webhook-body";

// POST /api/security/csp-report — recebe as violações do Content-Security-Policy(-Report-Only) enviadas pelo navegador.
// PÚBLICA de propósito: a violação pode acontecer na tela de login, sem sessão, e o navegador não manda credencial nesse POST.
// Por isso: corpo com teto de 16 KB, limite por IP, só campos higienizados (sem query, sem script-sample, sem referrer) e NADA é gravado no
// banco — vai para o log do servidor (uma linha por violação) para o ajuste da política no V2. Responde 204 em tudo que não for abuso.
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const ip = clientIp(request.headers) ?? "unknown";
  const limit = await checkRateLimit(`csp-report:${ip}`, RATE_LIMITS.cspReport);
  if (!limit.success) return new NextResponse(null, { status: 429 });

  const body = await readCappedBody(request, MAX_BODY_BYTES);
  if (!body.ok) return new NextResponse(null, { status: 413 });

  let payload: unknown = null;
  try {
    payload = body.text ? JSON.parse(body.text) : null;
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  for (const violation of sanitizeCspReports(payload)) {
    console.warn("[csp-report]", formatCspViolation(violation));
  }
  return new NextResponse(null, { status: 204 });
}
