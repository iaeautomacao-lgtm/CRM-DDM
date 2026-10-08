import type { SupabaseClient } from "@supabase/supabase-js";

// Contagem de itens da fila por status de UMA campanha, sem paginar a fila.
// Antes o callback de fim de campanha lia a fila inteira com .range() em OFFSET e SEM ORDER BY
// (O(N²/1000) e contagem instável com status mudando durante a leitura): 100k itens = 100 páginas.
//
// 1) RPC wacrm.get_campaign_stats (uma agregação no banco: GROUP BY campaign_id, status);
// 2) se a RPC não existir/falhar: um count exato por status (cada um usa o índice
//    (campaign_id, status, ...)), nunca OFFSET.

const KNOWN_STATUSES = [
  "agendado", "pendente", "pausado", "enviando", "enviado", "entregue", "lido", "erro", "bloqueado", "cancelado",
] as const;

export type CampaignStatusCounts = Record<string, number>;

export async function loadCampaignStatusCounts(
  db: Pick<SupabaseClient, "rpc" | "from">,
  campaignId: string
): Promise<CampaignStatusCounts | null> {
  const { data, error } = await db.rpc("get_campaign_stats", { p_campaign_ids: [campaignId] });
  if (!error) {
    const counts: CampaignStatusCounts = {};
    for (const row of (data ?? []) as Array<{ status: string; qty: number | string }>) {
      counts[row.status] = (counts[row.status] ?? 0) + Number(row.qty);
    }
    return counts;
  }

  const results = await Promise.all(
    KNOWN_STATUSES.map((status) =>
      db
        .from("disp_message_queue")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .eq("status", status)
    )
  );
  const counts: CampaignStatusCounts = {};
  for (const [i, result] of results.entries()) {
    if (result.error) {
      console.error("[Callback] Falha ao contar a fila da campanha:", campaignId, result.error.message);
      return null;
    }
    counts[KNOWN_STATUSES[i]] = result.count ?? 0;
  }
  return counts;
}

/** Totais do resumo do callback a partir das contagens por status. */
export function summarizeStatusCounts(counts: CampaignStatusCounts) {
  const n = (status: string) => counts[status] ?? 0;
  return {
    total_enfileirados: Object.values(counts).reduce((sum, q) => sum + q, 0),
    enviados: n("enviado") + n("entregue") + n("lido"),
    erros: n("erro"),
    bloqueados: n("bloqueado"),
    cancelados: n("cancelado"),
  };
}
