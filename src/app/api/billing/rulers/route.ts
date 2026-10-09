// /api/billing/rulers — PRD 17.5. GET: réguas da conta (billing.view). POST: cria (billing.manage); a régua nasce DESLIGADA e em dry-run.
import { guardPermission } from "@/lib/auth/route-guard";
import { readJsonObject } from "@/lib/webhooks-out/http";
import { createRuler, listRulers, parseRulerInput } from "@/lib/billing/ruler-api";
import { auditBilling, billingRoute } from "@/lib/billing/route-helpers";

export async function GET() {
  return billingRoute(await guardPermission("billing.view"), async ({ db, accountId }) => ({ rulers: await listRulers(db, accountId) }));
}

export async function POST(request: Request) {
  return billingRoute(await guardPermission("billing.manage"), async ({ db, accountId }) => {
    const patch = parseRulerInput(await readJsonObject(request), "create");
    const ruler = await createRuler(db, accountId, patch);
    await auditBilling({ accountId, action: "ruler.created", resourceId: ruler.id, label: ruler.name, fields: Object.keys(patch) });
    return { ruler };
  }, 201);
}
