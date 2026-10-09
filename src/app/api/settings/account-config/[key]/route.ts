// ============================================================
// PUT    /api/settings/account-config/{key}   grava o valor (validado contra o registro)      — settings.account (admin+)
// DELETE /api/settings/account-config/{key}   volta ao padrão (apaga a linha da conta)        — settings.account (admin+)
//
// Corpo do PUT: { value, reason? }. `reason` (até 200 caracteres) entra na observação da auditoria. Chave fora do registro = 404;
// valor inválido = 422 com a mensagem em pt-BR. Quem gravou e o antes → depois ficam na auditoria (trigger da migration 231).
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { registerAuditActor } from "@/lib/audit/context";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { settingDef, validateSetting } from "@/lib/settings/account-config";

type Params = { params: Promise<{ key: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY = 20_000;

const unavailable = (code: string | undefined) =>
  code === "42P01" || code === "PGRST205" ? NextResponse.json({ error: "Configurações da conta indisponíveis: aplique a migration 231" }, { status: 503, headers: NO_STORE }) : null;

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requirePermission("settings.account");
    const def = settingDef((await params).key);
    if (!def) return NextResponse.json({ error: "Configuração não encontrada" }, { status: 404, headers: NO_STORE });

    const limit = await checkRateLimit(`admin:account-config:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const text = await request.text();
    if (text.length > MAX_BODY) return NextResponse.json({ error: "Corpo grande demais" }, { status: 413, headers: NO_STORE });
    let body: { value?: unknown; reason?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return NextResponse.json({ error: "Corpo deve ser JSON válido" }, { status: 400, headers: NO_STORE });
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || !("value" in body)) {
      return NextResponse.json({ error: "Informe { value }" }, { status: 400, headers: NO_STORE });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
    if (body.reason !== undefined && typeof body.reason !== "string") return NextResponse.json({ error: "reason deve ser texto" }, { status: 400, headers: NO_STORE });

    const checked = validateSetting(def, body.value);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 422, headers: NO_STORE });

    if (reason) await registerAuditActor({ note: reason });
    const { error } = await supabaseAdmin()
      .from("account_settings")
      .upsert({ account_id: ctx.accountId, key: def.key, value: checked.value, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: "account_id,key" });
    if (error) {
      const gone = unavailable(error.code);
      if (gone) return gone;
      console.error("[PUT /api/settings/account-config] falha ao gravar:", error.code ?? "erro");
      return NextResponse.json({ error: "Falha ao gravar a configuração" }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json({ key: def.key, value: checked.value, source: "account" }, { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  void request;
  try {
    const ctx = await requirePermission("settings.account");
    const def = settingDef((await params).key);
    if (!def) return NextResponse.json({ error: "Configuração não encontrada" }, { status: 404, headers: NO_STORE });

    const limit = await checkRateLimit(`admin:account-config:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { error } = await supabaseAdmin().from("account_settings").delete().eq("account_id", ctx.accountId).eq("key", def.key);
    if (error) {
      const gone = unavailable(error.code);
      if (gone) return gone;
      console.error("[DELETE /api/settings/account-config] falha ao apagar:", error.code ?? "erro");
      return NextResponse.json({ error: "Falha ao voltar ao padrão" }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json({ key: def.key, value: def.default, source: "default" }, { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}
