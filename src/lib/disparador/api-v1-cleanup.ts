import type { SupabaseClient } from "@supabase/supabase-js";

/** Desfaz uma criação interrompida: apaga a fila, encerra a campanha e libera a chave de idempotência. */
export async function rollbackApiCampaign(db: SupabaseClient, campaignId: string, accountId: string): Promise<void> {
  const steps: Array<[string, PromiseLike<{ error: { message: string } | null }>]> = [
    ["fila", db.from("disp_message_queue").delete().eq("campaign_id", campaignId).eq("account_id", accountId)],
    ["métricas", db.from("campaign_metrics").delete().eq("campaign_id", campaignId)],
    // Deltas pendentes (migration 183): sem isto a consolidação recriaria a linha de métricas.
    ["deltas de métricas", db.from("campaign_metric_deltas").delete().eq("campaign_id", campaignId)],
    [
      "campanha",
      db
        .from("campaigns")
        .update({ status: "encerrada", idempotency_key: null, idempotency_response: null })
        .eq("id", campaignId)
        .eq("account_id", accountId),
    ],
  ];
  for (const [label, step] of steps) {
    const { error } = await step;
    if (error) console.error(`[v1/disparador] rollback (${label}) falhou para ${campaignId}:`, error.message);
  }
}

/** Reserva sem resposta há mais que isto = processo morreu no meio da criação (a criação normal leva segundos). */
export const API_DRAFT_STALE_MINUTES = 15;

/**
 * A7: campanha da API v1 que ficou em 'rascunho' (o processo caiu entre criar a campanha + chave de idempotência e
 * ativá-la). Sem isto o integrador recebe 409 "em andamento" para sempre e sobra fila parcial. Encerra com o mesmo
 * rollback da criação. Devolve quantas liberou; erro de leitura não propaga (manutenção best-effort).
 */
export async function sweepStuckApiCampaigns(
  db: SupabaseClient,
  options: { now?: () => number; olderThanMinutes?: number; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const cutoff = new Date(now() - (options.olderThanMinutes ?? API_DRAFT_STALE_MINUTES) * 60_000).toISOString();
  const { data, error } = await db
    .from("campaigns")
    .select("id, account_id")
    .eq("source", "api_v1")
    .eq("status", "rascunho")
    .lt("created_at", cutoff)
    .limit(options.limit ?? 20);
  if (error) {
    console.error("[v1/disparador] varredura de rascunhos presos falhou:", error.message);
    return 0;
  }
  const rows = (data ?? []) as Array<{ id: string; account_id: string }>;
  for (const row of rows) await rollbackApiCampaign(db, row.id, row.account_id);
  return rows.length;
}
