// ============================================================
// GET /api/v1/disparador/campaigns/[id] — status e métricas de uma
// campanha via API pública.
//
// Requer 'campaigns:read' OU 'campaigns:write' (quem pode criar
// campanhas também pode consultá-las). Só enxerga campanhas da própria
// conta — o id é sempre resolvido com .eq("account_id", ctx.accountId),
// então uma campanha de outra conta retorna 404, não 403 (não revela
// se o id existe).
// ============================================================

import { requireApiKey } from "@/lib/auth/api-context";
import { ok, notFound, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: campaignId } = await params;
  const logCtx: ApiCallLogContext = {
    method: "GET",
    route: "/api/v1/disparador/campaigns/[id]",
    startedAt: Date.now(),
  };
  try {
    const ctx = await requireApiKey(request, ["campaigns:read", "campaigns:write"]);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const db = supabaseAdmin();

    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .select("id, nome, status, created_at, janela_inicio, janela_fim")
      .eq("id", campaignId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (campaignError) throw campaignError;
    if (!campaign) {
      throw notFound("Campanha não encontrada");
    }

    const { data: metrics, error: metricsError } = await db
      .from("campaign_metrics")
      .select("total_contatos, total_enviados, total_entregues, total_lidos, total_erros")
      .eq("campaign_id", campaignId)
      .maybeSingle();

    if (metricsError) throw metricsError;

    const { data: statsRows, error: statsError } = await db.rpc("get_campaign_stats", {
      p_campaign_ids: [campaignId],
    });

    if (statsError) throw statsError;

    const queue = { agendado: 0, enviando: 0, entregue: 0, erro: 0, cancelado: 0 };
    for (const row of (statsRows ?? []) as Array<{ status: string; qty: number }>) {
      if (row.status in queue) {
        queue[row.status as keyof typeof queue] = Number(row.qty);
      }
    }

    return ok(
      {
        campaign_id: campaign.id,
        name: campaign.nome,
        status: campaign.status,
        created_at: campaign.created_at,
        window: {
          start: campaign.janela_inicio,
          end: campaign.janela_fim,
        },
        metrics: {
          total_contacts: metrics?.total_contatos ?? 0,
          sent: metrics?.total_enviados ?? 0,
          delivered: metrics?.total_entregues ?? 0,
          read: metrics?.total_lidos ?? 0,
          errors: metrics?.total_erros ?? 0,
          // Não é uma coluna própria de campaign_metrics — "pendente" é
          // o que ainda está agendado na fila, então reaproveita a
          // mesma contagem de queue.agendado abaixo.
          pending: queue.agendado,
        },
        queue,
      },
      200,
      logCtx
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
