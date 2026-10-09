// POST /api/billing/enrollments/:id/stop {motivo?} — PRD 17.5 (billing.manage). Para UMA inscrição (stop_reason = 'manual') e cancela os envios
// ainda não saídos; auditado. Só muda se estiver ativa ou pausada (senão 409). A dívida em si NÃO é alterada (paga/acordo vêm da fonte).
import { guardPermission } from "@/lib/auth/route-guard";
import { readJsonObject } from "@/lib/webhooks-out/http";
import { controlEnrollment, parseReason } from "@/lib/billing/ruler-api";
import { auditBilling, billingRoute, requireId } from "@/lib/billing/route-helpers";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return billingRoute(await guardPermission("billing.manage"), async ({ db, accountId }) => {
    requireId(id);
    const reason = parseReason(await readJsonObject(request));
    const result = await controlEnrollment(db, accountId, id, "stop");
    await auditBilling({ accountId, action: "enrollment.stopped", resourceId: id, reason, metadata: { ruler_id: result.enrollment.ruler_id, debt_id: result.enrollment.debt_id, cancelled_sends: result.cancelled_sends } });
    return result;
  });
}
