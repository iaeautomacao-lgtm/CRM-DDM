import { NextResponse } from "next/server";

import { guardRole, type GuardResult } from "@/lib/auth/route-guard";

// Papel mínimo para mexer em fluxos (criar, editar, ativar, apagar, importar,
// ver execuções): o mesmo da página /flows (owner/admin — ROUTE_ALLOWLIST).
// Antes as rotas só pediam sessão e escreviam com service role, então um
// viewer/agente chamando a API direto editava fluxos e prompts de IA.

export async function guardFlowAccess(): Promise<GuardResult> {
  return guardRole("admin");
}

/**
 * Papel + posse: o fluxo precisa existir NA CONTA do chamador (outra conta →
 * 404, sem revelar que existe). Devolve o contexto para as escritas com
 * service role filtrarem por `ctx.accountId`.
 */
export async function guardFlow(flowId: string): Promise<GuardResult> {
  const auth = await guardFlowAccess();
  if (!auth.ok) return auth;
  const { data } = await auth.ctx.supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("account_id", auth.ctx.accountId)
    .limit(1);
  if (!data || data.length === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  return auth;
}
