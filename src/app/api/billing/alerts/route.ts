// GET /api/billing/alerts — PRD 17.6 (billing.view). Alertas ativos da régua da conta: sincronização sem sucesso (> 1 h), etapas reservadas
// há > 15 min, taxa de consultas adiadas por falha da DDM (> 20% na última hora) e régua ligada sem canal saudável. Lista vazia = tudo certo.
import { guardPermission } from "@/lib/auth/route-guard";
import { billingAlerts } from "@/lib/billing/reports";
import { billingRoute } from "@/lib/billing/route-helpers";

export async function GET() {
  return billingRoute(await guardPermission("billing.view"), ({ db, accountId }) => billingAlerts(db, accountId));
}
