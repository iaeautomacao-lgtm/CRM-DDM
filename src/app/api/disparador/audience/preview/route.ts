import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadCampaignAudience } from "@/lib/disparador/audience";
import { loadBlacklistKeySet } from "@/lib/disparador/blacklist-keys";
import { phoneKey } from "@/lib/disparador/phone-key";

// POST /api/disparador/audience/preview — público de uma campanha AINDA NÃO
// SALVA, sem base importada (tabulações ou conta inteira). Mesma resolução
// do startCampaign (audience.ts), para o assistente mostrar o público real e
// calcular a previsão de término. Só leitura.
//
// Corpo: { tags_filtro: string[] } — vazio = conta inteira.

export async function POST(request: Request) {
  try {
    const { accountId } = await requireDisparadorAccess();
    const body = (await request.json().catch(() => null)) as { tags_filtro?: unknown } | null;
    const tags = Array.isArray(body?.tags_filtro)
      ? body.tags_filtro.filter((t): t is string => typeof t === "string" && t.trim() !== "")
      : [];
    const db = supabaseAdmin();
    // id aleatório: nenhum import vinculado — só tabulação/conta.
    const audience = await loadCampaignAudience(
      db,
      accountId,
      { id: randomUUID(), import_draft_id: null, tags_filtro: tags, audience_mode: tags.length > 0 ? "tags" : "account" },
      "id, phone"
    );
    if (!audience.ok) return NextResponse.json({ ok: false, error: audience.error });

    const keys = await loadBlacklistKeySet(db);
    const blacklisted = audience.contacts.filter((c) => typeof c.phone === "string" && keys.has(phoneKey(c.phone))).length;
    return NextResponse.json({
      ok: true,
      total: audience.contacts.length,
      blacklisted,
      source: audience.source,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
