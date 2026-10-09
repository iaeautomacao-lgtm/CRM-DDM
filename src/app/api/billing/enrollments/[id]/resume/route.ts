// POST /api/billing/enrollments/:id/resume {motivo?} — PRD 17.5 (billing.manage). Retoma UMA inscrição pausada, auditado.
// Só muda se estiver pausada (senão 409). A próxima etapa segue as regras do motor (janela, teto, tolerância): etapa muito atrasada expira, não sai em rajada.
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
    const result = await controlEnrollment(db, accountId, id, "resume");
    await auditBilling({ accountId, action: "enrollment.resumed", resourceId: id, reason, metadata: { ruler_id: result.enrollment.ruler_id, debt_id: result.enrollment.debt_id } });
    return result;
  });
}
