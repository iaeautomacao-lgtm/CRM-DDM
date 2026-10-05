import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadCampaignAudience } from "@/lib/disparador/audience";

// GET /api/disparador/campaigns/[id]/audience — quem a campanha vai
// atingir, para o modal de "Iniciar" (PRD-01). Mesma resolução que
// startCampaign usa (src/lib/disparador/audience.ts), sem enfileirar nada.
// Já enviados e blacklist são informados à parte: startCampaign pula esses.

const LABEL: Record<string, string> = {
  csv: "contatos do CSV importado",
  "csv+tags": "contatos do CSV com as tabulações selecionadas",
  tags: "contatos com as tabulações selecionadas",
  account: "todos os contatos da conta",
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await getCurrentAccount();
    const { id } = await params;
    const db = supabaseAdmin();

    const { data: rows, error } = await db
      .from("campaigns")
      .select("id, account_id, import_draft_id, tags_filtro, audience_mode")
      .eq("id", id)
      .eq("account_id", accountId)
      .limit(1);
    if (error) throw error;
    const campaign = rows?.[0];
    if (!campaign) return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });

    const audience = await loadCampaignAudience(db, accountId, campaign, "id");
    if (!audience.ok) return NextResponse.json({ ok: false, error: audience.error });

    const { count: alreadySent } = await db
      .from("disp_message_queue")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id)
      .in("status", ["enviado", "entregue", "lido"]);

    return NextResponse.json({
      ok: true,
      total: audience.contacts.length,
      source: audience.source,
      source_label: LABEL[audience.source] ?? audience.source,
      tags: Array.isArray(campaign.tags_filtro) ? campaign.tags_filtro : [],
      already_sent: alreadySent ?? 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
