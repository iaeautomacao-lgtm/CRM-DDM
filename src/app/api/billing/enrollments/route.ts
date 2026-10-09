// GET /api/billing/enrollments?status=&motivo=&ruler_id=&cursor=&limit= — PRD 17.5 (billing.view). Lista paginada por keyset (created_at, id) com o motivo
// de parada. Devolve o NOME do contato e a dívida (vencimento, valor em centavos, referência) — nunca telefone nem CPF.
import { guardPermission } from "@/lib/auth/route-guard";
import { listEnrollments } from "@/lib/billing/ruler-api";
import { billingRoute } from "@/lib/billing/route-helpers";

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  return billingRoute(await guardPermission("billing.view"), ({ db, accountId }) =>
    listEnrollments(db, accountId, {
      status: sp.get("status") ?? undefined,
      motivo: sp.get("motivo") ?? undefined,
      ruler_id: sp.get("ruler_id") ?? undefined,
      cursor: sp.get("cursor"),
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
    }),
  );
}
