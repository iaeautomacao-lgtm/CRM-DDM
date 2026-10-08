import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { logAuditEvent } from "@/lib/audit/log-event";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import {
  applyLimitsChange,
  AUDIT_RESOURCE,
  LimitsInputError,
  loadLimitsOverview,
  parseLimitsRequest,
  summarizeChanges,
  type LimitsDb,
} from "@/lib/disparador/limits";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

function fail(err: unknown): Response {
  if (err instanceof LimitsInputError) {
    return NextResponse.json({ ok: false, error: err.message }, { status: err.status, headers: NO_STORE });
  }
  const response = toErrorResponse(err);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

// GET /api/disparador/limits — números da conta com vagas/limite por hora/pausa, globais (só leitura) e histórico.
export async function GET() {
  try {
    const { accountId } = await requireDisparadorAccess();
    const overview = await loadLimitsOverview(supabaseAdmin() as unknown as LimitsDb, accountId);
    return NextResponse.json({ ok: true, ...overview }, { headers: NO_STORE });
  } catch (err) {
    return fail(err);
  }
}

// PUT /api/disparador/limits { sessionId, maxInFlight?, hourlyLimit?, paused?, reason, confirm: true, expected? }
// Edita um número da conta da sessão (owner/admin). Faixa por provedor, motivo obrigatório, confirmação
// explícita, recusa se o "antes" mudou (409), audita o "antes → depois". Vale no próximo tick.
export async function PUT(request: Request) {
  try {
    const { accountId } = await requireDisparadorAccess();
    const body = await request.json().catch(() => null);
    const req = parseLimitsRequest(body);
    const db = supabaseAdmin() as unknown as LimitsDb;

    const result = await applyLimitsChange(db, accountId, req);
    if (!result.noop) {
      await logAuditEvent({
        accountId,
        eventType: "updated",
        resourceType: AUDIT_RESOURCE,
        resourceId: req.sessionId,
        resourceLabel: result.label,
        action: "disparador.limits_changed",
        summary: summarizeChanges(result.label, result.changes),
        changes: Object.fromEntries(result.changes.map((c) => [c.field, { before: c.before, after: c.after }])),
        metadata: { reason: req.reason, sessionId: req.sessionId },
      });
    }
    return NextResponse.json({ ok: true, changed: !result.noop, changes: result.changes, after: result.after }, { headers: NO_STORE });
  } catch (err) {
    return fail(err);
  }
}
