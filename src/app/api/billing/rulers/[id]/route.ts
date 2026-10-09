// /api/billing/rulers/:id — PRD 17.5. GET: régua + etapas (billing.view). PATCH/DELETE (billing.manage).
// Ligar a régua (active) exige canal e ao menos uma etapa ativa; apagar só régua desligada e sem histórico de inscrições.
import { guardPermission } from "@/lib/auth/route-guard";
import { readJsonObject } from "@/lib/webhooks-out/http";
import { deleteRuler, getRuler, listSteps, parseRulerInput, updateRuler } from "@/lib/billing/ruler-api";
import { auditBilling, billingRoute, requireId } from "@/lib/billing/route-helpers";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return billingRoute(await guardPermission("billing.view"), async ({ db, accountId }) => {
    requireId(id);
    const ruler = await getRuler(db, accountId, id);
    return { ruler, steps: await listSteps(db, accountId, id) };
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return billingRoute(await guardPermission("billing.manage"), async ({ db, accountId }) => {
    requireId(id);
    const patch = parseRulerInput(await readJsonObject(request), "patch");
    const { ruler, changed } = await updateRuler(db, accountId, id, patch);
    if (changed.length > 0) {
      const live = changed.includes("active") || changed.includes("dry_run") ? { active: ruler.active, dry_run: ruler.dry_run } : undefined;
      await auditBilling({ accountId, action: "ruler.updated", resourceId: id, label: ruler.name, fields: changed, metadata: live });
    }
    return { ruler };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  return billingRoute(await guardPermission("billing.manage"), async ({ db, accountId }) => {
    requireId(id);
    const ruler = await deleteRuler(db, accountId, id);
    await auditBilling({ accountId, action: "ruler.deleted", resourceId: id, label: ruler.name });
    return { deleted: true };
  });
}
