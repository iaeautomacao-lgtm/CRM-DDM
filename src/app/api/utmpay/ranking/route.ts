import { NextResponse } from "next/server";
import { guardPermission } from "@/lib/auth/route-guard";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { buildFunnelView, loadAttendantNames, type FunnelStats } from "@/lib/utmpay/stats";

export const dynamic = "force-dynamic";

// GET /api/utmpay/ranking?dias=30 — quem fechou/pagou no período, na conta toda (permissão campaigns.view). Considera os links criados nos últimos
// `dias` (1–365, padrão 30). → { available, dias, fechou, pagou, por_atribuicao:{fechou,pagou}, por_atendente:[{ atendente_id, atendente_nome, fechou, pagou }] }
export async function GET(request: Request) {
  const auth = await guardPermission("campaigns.view");
  if (!auth.ok) return auth.response;
  const { accountId } = auth.ctx;

  const raw = Number(new URL(request.url).searchParams.get("dias") ?? "30");
  const dias = Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : 30;
  const since = new Date(Date.now() - dias * 86_400_000).toISOString();

  const db = supabaseAdmin();
  const { data, error } = await db.rpc("utmpay_funnel", { p_account: accountId, p_campaign: null, p_since: since });
  if (error) {
    return NextResponse.json({ available: false, dias, fechou: 0, pagou: 0, por_atribuicao: { fechou: { direto: 0, ia: 0, humano: 0 }, pagou: { direto: 0, ia: 0, humano: 0 } }, por_atendente: [] });
  }
  const stats = (data ?? null) as FunnelStats | null;
  const names = await loadAttendantNames(db, (stats?.por_atendente ?? []).map((a) => a.atendente_id));
  const view = buildFunnelView({ available: true, tracking: true, delivered: 0, stats, names });
  return NextResponse.json({ available: true, dias, fechou: view.fechou, pagou: view.pagou, por_atribuicao: view.por_atribuicao, por_atendente: view.por_atendente });
}
