import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse } from "@/lib/pausas/http";
import { parseReportParams, pauseReport } from "@/lib/pausas/service";

// GET /api/pausas/relatorio?de=AAAA-MM-DD&ate=AAAA-MM-DD[&equipe][&atendente][&motivo][&detalhe=1][&limite][&cursor]
// Por atendente: nº de pausas, tempo total/médio, maior, por motivo, quantas estouraram o limite e % do tempo logado (agent_sessions). Datas
// inclusivas, calendário de Brasília, no máximo 92 dias. O ESCOPO (equipes dele ou conta toda) vem da RLS de agent_pauses: reports.view_team
// vê as equipes dele, reports.view_all a conta. Detalhe cronológico (detalhe=1) com cursor. Contrato: prd-v2/pausas-contrato-api.md.
export async function GET(request: Request) {
  try {
    const ctx = await requirePermission("reports.view_team");
    const params = parseReportParams(new URL(request.url).searchParams);
    return NextResponse.json(await pauseReport(ctx.supabase, supabaseAdmin(), ctx.accountId, params));
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
