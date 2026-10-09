// POST /api/billing/enrollments/:id/pause {motivo?} — PRD 17.5 (billing.manage). Pausa UMA inscrição, auditado (quem, quando, motivo).
// Só muda se a inscrição estiver ativa (senão 409). Nunca chama efetivação de acordo.
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
    const result = await controlEnrollment(db, accountId, id, "pause");
    await auditBilling({ accountId, action: "enrollment.paused", resourceId: id, reason, metadata: { ruler_id: result.enrollment.ruler_id, debt_id: result.enrollment.debt_id } });
    return result;
  });
}
