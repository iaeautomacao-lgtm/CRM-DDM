// GET /api/billing/rulers/:id/metrics — PRD 17.5 (billing.view). Envios por etapa e status + inscrições por status/motivo de parada, agregados no banco.
// Respondidas e "pagas após cobrança" chegam na PR 17.6.
import { guardPermission } from "@/lib/auth/route-guard";
import { rulerMetrics } from "@/lib/billing/ruler-api";
import { billingRoute, requireId } from "@/lib/billing/route-helpers";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return billingRoute(await guardPermission("billing.view"), async ({ db, accountId }) => {
    requireId(id);
    return rulerMetrics(db, accountId, id);
  });
}
