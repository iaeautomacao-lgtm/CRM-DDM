import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { logAuditEvent } from "@/lib/audit/log-event";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import {
  decodeCursor,
  ERROS_MAX_PAGE_SIZE,
  ERROS_PAGE_SIZE,
  ErrosInputError,
  errosToCsv,
  listErros,
  listErrosForExport,
  loadCampaignOptions,
  loadErrosSummary,
  loadNumbers,
  parseErrosFilters,
  resolveFilters,
  type ErrosDb,
} from "@/lib/disparador/erros";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

// GET /api/disparador/erros?campaign=&session=&code=&classe=&periodo=1h|24h|7d|30d|all&phone=&cursor=&limit=50
//   &summary=1            → inclui o resumo por código (ignora code/classe, para os chips continuarem clicáveis)
//   &format=csv           → exporta a lista filtrada (teto de 10.000 linhas); auditado
//
// Só leitura. Escopado pela conta da sessão (mesmo papel das demais telas do Disparador: owner/admin).
// Lista keyset (updated_at desc, id desc): sem OFFSET e sem count exact.
export async function GET(request: Request) {
  try {
    const { accountId, userId } = await requireDisparadorAccess();
    const params = new URL(request.url).searchParams;
    const db = supabaseAdmin() as unknown as ErrosDb;

    const filters = parseErrosFilters(params);
    const numbers = await loadNumbers(db, accountId);
    const resolved = await resolveFilters(db, accountId, filters, numbers);

    if (params.get("format") === "csv") {
      const { items, truncated } = await listErrosForExport(db, accountId, resolved, numbers);
      await logAuditEvent({
        accountId,
        eventType: "action",
        resourceType: "disparador",
        resourceId: filters.campaign ?? accountId,
        action: "disparador.errors_exported",
        summary: `Exportou ${items.length} erro(s) do disparador${truncated ? " (limitado ao teto)" : ""}`,
        metadata: { filters, rows: items.length, truncated, userId },
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      return new Response(errosToCsv(items), {
        headers: {
          ...NO_STORE,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="erros-disparador-${stamp}.csv"`,
          "X-Export-Truncated": truncated ? "1" : "0",
        },
      });
    }

    const rawLimit = Number(params.get("limit") ?? ERROS_PAGE_SIZE);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), ERROS_MAX_PAGE_SIZE) : ERROS_PAGE_SIZE;
    const cursor = decodeCursor(params.get("cursor"));

    const withSummary = params.get("summary") === "1";
    const [page, summary, campaigns] = await Promise.all([
      listErros(db, accountId, resolved, numbers, cursor, limit),
      withSummary ? loadErrosSummary(db, accountId, resolved) : Promise.resolve(null),
      withSummary ? loadCampaignOptions(db, accountId) : Promise.resolve(null),
    ]);

    return NextResponse.json(
      { ok: true, items: page.items, nextCursor: page.nextCursor, summary, numbers, campaigns },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof ErrosInputError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status, headers: NO_STORE });
    }
    const response = toErrorResponse(err);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
}
