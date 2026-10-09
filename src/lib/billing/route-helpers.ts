import "server-only";
// PRD 17, PR 17.5 — cola comum das rotas /api/billing/*: resposta no envelope v1, 404 para id malformado e auditoria de ações da régua.
import { NextResponse } from "next/server";

import { ApiError, notFound, toApiErrorResponse } from "@/lib/api/v1/respond";
import { logAuditEvent, type AuditEventParams } from "@/lib/audit/log-event";
import type { GuardResult } from "@/lib/auth/route-guard";
import { supabaseAdmin } from "@/lib/flows/admin-client";

import { validUuid, type Db } from "./ruler-api";

export type BillingCtx = { accountId: string; userId: string | null; db: Db };

/** `auth` = guardPermission('billing.view' | 'billing.manage') chamado na própria rota (a matriz de permissões confere no arquivo). */
export async function billingRoute(auth: GuardResult, run: (ctx: BillingCtx) => Promise<unknown>, status = 200): Promise<NextResponse> {
  if (!auth.ok) return auth.response;
  try {
    const body = await run({ accountId: auth.ctx.accountId, userId: auth.ctx.userId ?? null, db: supabaseAdmin() });
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ApiError) return toApiErrorResponse(err);
    console.error("[billing/api] falha:", err instanceof Error ? err.message : "erro");
    return NextResponse.json({ error: { code: "internal", message: "Não foi possível concluir a operação." } }, { status: 500 });
  }
}

/** Id da URL malformado ⇒ 404 sem tocar no banco. */
export function requireId(id: string): string {
  if (!validUuid(id)) throw notFound("Não encontrado");
  return id;
}

type AuditAction =
  | "ruler.created" | "ruler.updated" | "ruler.deleted" | "ruler.steps_replaced" | "ruler.dry_run"
  | "enrollment.paused" | "enrollment.resumed" | "enrollment.stopped";

const SUMMARY: Record<AuditAction, string> = {
  "ruler.created": "Régua de cobrança criada",
  "ruler.updated": "Régua de cobrança alterada",
  "ruler.deleted": "Régua de cobrança apagada",
  "ruler.steps_replaced": "Etapas da régua de cobrança atualizadas",
  "ruler.dry_run": "Simulação da régua de cobrança",
  "enrollment.paused": "Cobrança de uma dívida pausada manualmente",
  "enrollment.resumed": "Cobrança de uma dívida retomada",
  "enrollment.stopped": "Cobrança de uma dívida parada manualmente",
};

/**
 * Evento de auditoria (PRD 17.5). Só NOMES de campos, contagens e ids — nunca texto de mensagem, telefone ou CPF. `reason` é a observação
 * livre de quem pausou/parou (até 200 caracteres, validada na rota).
 */
export function billingAuditEvent(input: { accountId: string; action: AuditAction; resourceId: string; label?: string; fields?: string[]; metadata?: Record<string, unknown>; reason?: string | null }): AuditEventParams {
  const kind = input.action.endsWith("created") ? "created" : input.action.endsWith("deleted") ? "deleted" : input.action.endsWith("updated") ? "updated" : "action";
  return {
    accountId: input.accountId,
    eventType: kind,
    resourceType: input.action.startsWith("ruler") ? "billing_ruler" : "billing_enrollment",
    resourceId: input.resourceId,
    resourceLabel: input.label,
    action: `billing.${input.action}`,
    summary: input.label ? `${SUMMARY[input.action]}: ${input.label}` : SUMMARY[input.action],
    metadata: { ...(input.fields ? { fields: input.fields } : {}), ...(input.reason ? { reason: input.reason } : {}), ...(input.metadata ?? {}) },
  };
}

export async function auditBilling(input: Parameters<typeof billingAuditEvent>[0]): Promise<void> {
  await logAuditEvent(billingAuditEvent(input));
}
