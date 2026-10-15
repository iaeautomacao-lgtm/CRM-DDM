import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { ddmAllowance, fetchDdmSituation } from "@/lib/billing/ddm-source";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { loadUtmpayConfig } from "@/lib/utmpay/config";
import { detectFromDdm, recheckPendingPayments } from "@/lib/utmpay/ingest";

export const dynamic = "force-dynamic";

// POST /api/integrations/utmpay/recheck — confere de novo os eventos `paid` que a API DDM ainda não confirmou (DDM fora do ar na hora, ou a
// baixa ainda não refletida). Cron com segredo (x-cron-secret = AUTOMATION_CRON_SECRET), a cada ~15 min. Até 50 por chamada, últimos 14 dias.
// `paid` nunca é confiado sozinho: só vira "pagou" quando a DDM confirma. Também DETECTA fechou/pagou por consulta à DDM dos links que já clicaram
// (o DDMPay hoje só manda `click`; até 50 CPFs por execução). GET só diagnóstico (não executa).
const FAILED = { checked: 0, confirmed: 0, detection: { checked: 0, fechou: 0, pagou: 0, unknown: 0 } };

async function handle(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const supplied = Buffer.from(request.headers.get("x-cron-secret") ?? "");
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = supabaseAdmin();
    // O teto de consultas à DDM é por conta; na conferência em lote usa o balde geral do UTMpay.
    const deps = { situation: (cpf: string) => fetchDdmSituation(cpf, { allow: ddmAllowance("utmpay-recheck") }) };
    // 1) `paid` recebido do UTMpay e ainda não confirmado pela DDM; 2) detecção de fechou/pagou por consulta à DDM (o DDMPay hoje só manda `click`).
    const confirmation = await recheckPendingPayments(db, deps);
    const detection = await detectFromDdm(db, { ...deps, windowDays: async (accountId) => (await loadUtmpayConfig(db, accountId))?.janelaDias ?? 7 });
    return NextResponse.json({ ...confirmation, detection });
  } catch (err) {
    console.error("[utmpay-recheck] falhou:", err instanceof Error ? err.message.slice(0, 120) : "erro");
    return NextResponse.json({ ...FAILED, error: "Falha na conferência" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET() {
  return NextResponse.json({ info: "Use POST com x-cron-secret", executes: false });
}
