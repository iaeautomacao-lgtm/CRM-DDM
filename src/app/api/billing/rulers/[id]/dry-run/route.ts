// POST /api/billing/rulers/:id/dry-run {date} — PRD 17.5 (billing.manage). Quantas dívidas teriam etapa nessa data, por etapa. NÃO cria fila nem envio.
import { guardPermission } from "@/lib/auth/route-guard";
import { readJsonObject } from "@/lib/webhooks-out/http";
import { dryRun, parseCivilDate } from "@/lib/billing/ruler-api";
import { billingRoute, requireId } from "@/lib/billing/route-helpers";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return billingRoute(await guardPermission("billing.manage"), async ({ db, accountId }) => {
    requireId(id);
    const body = await readJsonObject(request);
    return dryRun(db, accountId, id, parseCivilDate(body.date));
  });
}
