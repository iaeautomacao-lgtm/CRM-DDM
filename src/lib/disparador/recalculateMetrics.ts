import { supabaseAdmin } from "./admin-client";

// Status de campanha que valem a pena recalcular — campanhas em
// 'rascunho' nunca geraram disp_message_queue, então não há nada pra
// recontar. 'em_execucao'/'pausada' pegam drift enquanto a campanha
// ainda está rodando; 'encerrada' é o estado terminal real deste
// projeto (ver disparador/campanhas/page.tsx) — não existe status
// 'finalizada' no schema atual.
const RECALCULABLE_STATUSES = ["em_execucao", "pausada", "encerrada"] as const;

export interface RecalculateMetricsSummary {
  total: number;
  success: number;
  failed: number;
  errors: string[];
}

// Varre as campanhas da conta nos status acima e chama a RPC
// wacrm.recalculate_campaign_metrics (migration 112) pra cada uma,
// uma de cada vez — mesmo padrão sequencial usado no completion sweep
// do cron (src/app/api/disparador/cron/route.ts) em vez de
// Promise.all, pra não disparar N updates concorrentes na mesma
// campaign_metrics row.
export async function recalculateAllCampaignMetrics(
  accountId: string
): Promise<RecalculateMetricsSummary> {
  const { data: campaigns, error: fetchError } = await supabaseAdmin()
    .from("campaigns")
    .select("id, nome")
    .eq("account_id", accountId)
    .in("status", RECALCULABLE_STATUSES);

  if (fetchError) {
    throw new Error(`Falha ao buscar campanhas: ${fetchError.message}`);
  }

  const summary: RecalculateMetricsSummary = {
    total: campaigns?.length ?? 0,
    success: 0,
    failed: 0,
    errors: [],
  };

  for (const campaign of campaigns ?? []) {
    const { error } = await supabaseAdmin().rpc("recalculate_campaign_metrics", {
      p_campaign_id: campaign.id,
    });

    if (error) {
      summary.failed++;
      summary.errors.push(`${campaign.nome || campaign.id}: ${error.message}`);
    } else {
      summary.success++;
    }
  }

  return summary;
}
