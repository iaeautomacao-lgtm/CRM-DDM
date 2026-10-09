// PUT /api/billing/rulers/:id/steps — PRD 17.5 (billing.manage). Troca a lista de etapas numa transação (RPC billing_replace_steps):
// deslocamentos únicos, template Meta aprovado, {{n}} cobertos pelo variable_map; etapa com histórico de envio não some (active=false).
import { guardPermission } from "@/lib/auth/route-guard";
import { readJsonObject } from "@/lib/webhooks-out/http";
import { getRuler, parseStepsInput, replaceSteps } from "@/lib/billing/ruler-api";
import { auditBilling, billingRoute, requireId } from "@/lib/billing/route-helpers";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  return billingRoute(await guardPermission("billing.manage"), async ({ db, accountId }) => {
    requireId(id);
    const steps = parseStepsInput(await readJsonObject(request));
    const ruler = await getRuler(db, accountId, id);
    const saved = await replaceSteps(db, accountId, ruler, steps);
    await auditBilling({
      accountId,
      action: "ruler.steps_replaced",
      resourceId: id,
      label: ruler.name,
      metadata: { steps: saved.length, offsets: saved.filter((s) => s.kind === "offset").map((s) => s.offset_days), active_steps: saved.filter((s) => s.active).length },
    });
    return { steps: saved };
  });
}
