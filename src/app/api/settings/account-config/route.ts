// ============================================================
// GET /api/settings/account-config   (PRD 19.3 / PRD 24, item 6)
//
// Configurações da conta (fuso, horário de atendimento, preferências de notificação): registro em código × o que a conta gravou em
// wacrm.account_settings (migration 231). Qualquer membro lê (nada aqui é sensível: credenciais ficam no cofre); `editable` diz se o
// chamador pode gravar (settings.account, admin+). Sem a migration 231 ainda: devolve os padrões do registro (nunca quebra a tela).
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { can } from "@/lib/auth/permissions";
import { resolveSettings } from "@/lib/settings/account-config";

export async function GET() {
  try {
    const ctx = await requirePermission("account.view");
    const stored = new Map<string, unknown>();
    const { data, error } = await supabaseAdmin().from("account_settings").select("key, value").eq("account_id", ctx.accountId);
    if (error) {
      console.warn("[GET /api/settings/account-config] leitura indisponível:", error.code ?? "erro");
    } else {
      for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) stored.set(row.key, row.value);
    }
    return NextResponse.json({ settings: resolveSettings(stored, can(ctx, "settings.account")) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
