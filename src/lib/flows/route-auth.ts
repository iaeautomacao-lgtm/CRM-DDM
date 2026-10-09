import { NextResponse } from "next/server";

import type { Permission } from "@/lib/auth/permissions";
import { guardPermission, type GuardResult } from "@/lib/auth/route-guard";

// Permissão para mexer em fluxos (PRD 20, 20.3d): `flows.edit` (criar, editar, ativar, apagar, importar) ou
// `flows.view_runs` (ver execuções; apagar o histórico é escrita e pede `flows.edit`) — hoje ambas owner/admin, os mesmos da página /flows.
// Antes as rotas só pediam sessão e escreviam com service role, então um
// viewer/agente chamando a API direto editava fluxos e prompts de IA.

export type FlowPermission = Extract<Permission, "flows.edit" | "flows.view_runs">;

export async function guardFlowAccess(permission: FlowPermission = "flows.edit"): Promise<GuardResult> {
  return guardPermission(permission);
}

/**
 * Papel + posse: o fluxo precisa existir NA CONTA do chamador (outra conta →
 * 404, sem revelar que existe). Devolve o contexto para as escritas com
 * service role filtrarem por `ctx.accountId`.
 */
export async function guardFlow(flowId: string, permission: FlowPermission = "flows.edit"): Promise<GuardResult> {
  const auth = await guardFlowAccess(permission);
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
      response: NextResponse.json({ error: "Não encontrado" }, { status: 404 }),
    };
  }
  return auth;
}
