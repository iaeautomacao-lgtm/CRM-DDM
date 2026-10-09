// GET /api/billing/rulers/:id/report?from=AAAA-MM-DD&to=AAAA-MM-DD — PRD 17.6 (billing.view). Relatório por período (padrão: últimos 30 dias, máx. 93):
// por etapa enviadas/entregues/lidas/respondidas/erros/PAGAS APÓS COBRANÇA, totais, cobranças até o pagamento e série diária. Só contagens.
// "Paga após cobrança" = pagamento detectado depois de uma etapa enviada (correlação, não causa) — ver o cabeçalho da migration 320.
import { guardPermission } from "@/lib/auth/route-guard";
import { parseReportRange, rulerReport } from "@/lib/billing/reports";
import { billingRoute, requireId } from "@/lib/billing/route-helpers";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const sp = new URL(request.url).searchParams;
  return billingRoute(await guardPermission("billing.view"), async ({ db, accountId }) => {
    requireId(id);
    return rulerReport(db, accountId, id, parseReportRange(sp.get("from"), sp.get("to")));
  });
}
