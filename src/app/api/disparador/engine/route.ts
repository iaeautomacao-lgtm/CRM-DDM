import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import {
  buildEngineFlagsView,
  EngineFlagsError,
  loadEngineFlagRows,
  parseEngineFlagsPatch,
  saveEngineFlags,
} from "@/lib/disparador/engine-flags";

// Chaves do motor do Disparador pela tela (decisão do dono, 15/10; migration 366). Permissão campaigns.rate_limit (admin e proprietário).
// GET  /api/disparador/engine → { account: {batch_claim, tick_chain}, effective: {…: {enabled, source}}, env: {…} }
//        account: valor desta conta (null = segue o ambiente); effective: o que o motor usa agora; env: o valor do ambiente sozinho.
// PUT  /api/disparador/engine → { batch_claim?: boolean|null, tick_chain?: boolean|null } (null = volta a seguir o ambiente).
//        Vale no próximo tick (até ~10 s), sem reinício. O motor é compartilhado: ligar em qualquer conta liga para todas.

function handle(err: unknown) {
  if (err instanceof EngineFlagsError) return NextResponse.json({ error: err.message }, { status: err.status });
  return toErrorResponse(err);
}

export async function GET() {
  try {
    const ctx = await requireDisparadorAccess("campaigns.rate_limit");
    const rows = await loadEngineFlagRows(supabaseAdmin(), { ttlMs: 0 });
    return NextResponse.json(buildEngineFlagsView(ctx.accountId, rows));
  } catch (err) {
    return handle(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireDisparadorAccess("campaigns.rate_limit");
    const patch = parseEngineFlagsPatch(await request.json().catch(() => null));
    const db = supabaseAdmin();
    const before = buildEngineFlagsView(ctx.accountId, await loadEngineFlagRows(db, { ttlMs: 0 })).account;
    await saveEngineFlags(db, { accountId: ctx.accountId, userId: ctx.userId ?? null, patch });
    const rows = await loadEngineFlagRows(db, { ttlMs: 0 });
    const view = buildEngineFlagsView(ctx.accountId, rows);
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of ["batch_claim", "tick_chain"] as const) {
      if (patch[key] !== undefined && before[key] !== view.account[key]) changes[key] = { before: before[key], after: view.account[key] };
    }
    if (Object.keys(changes).length > 0) {
      await logAuditEvent({
        accountId: ctx.accountId,
        eventType: "updated",
        resourceType: "dispatch_engine",
        resourceId: ctx.accountId,
        action: "dispatch.engine_flags_changed",
        summary: "Chaves do motor do Disparador alteradas",
        changes,
      });
    }
    return NextResponse.json(view);
  } catch (err) {
    return handle(err);
  }
}
