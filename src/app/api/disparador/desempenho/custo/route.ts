import { NextRequest, NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadCostSummary } from "@/lib/whatsapp/message-pricing";
import { WINDOW_MS, type DesempenhoWindow } from "@/lib/disparador/desempenho";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Custo Meta por categoria (migration 195): mensagens por campanha × número × categoria × cobrável, a partir do pricing que a Meta
// manda no webhook de status. ?campaign_id=<uuid> restringe a uma campanha; ?window=15m|1h|6h|24h restringe o período.
// Contagens, não reais: a tarifa varia por país/moeda/vigência (o painel multiplica pela tabela de preços da conta).
export async function GET(request: NextRequest) {
  try {
    const { accountId } = await requireDisparadorAccess();
    const params = request.nextUrl.searchParams;

    const campaignId = params.get("campaign_id");
    if (campaignId && !UUID.test(campaignId)) {
      return NextResponse.json({ ok: false, error: "campaign_id inválido" }, { status: 400 });
    }
    const win = params.get("window") as DesempenhoWindow | null;
    if (win && !(win in WINDOW_MS)) {
      return NextResponse.json({ ok: false, error: "window inválida (15m, 1h, 6h, 24h)" }, { status: 400 });
    }
    const since = win ? new Date(Date.now() - WINDOW_MS[win]).toISOString() : null;

    const cost = await loadCostSummary(supabaseAdmin(), accountId, { campaignId, since });
    return NextResponse.json({ ok: true, cost }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
