// Total do detalhamento da fila SEM `count: "exact"` junto da página (A20/A21, PRD 11).
//
// Antes cada página do modal de métricas fazia `select(..., { count: "exact" })` + `.range()`: o banco contava e
// ordenava a fila inteira da campanha (100 mil itens) a cada clique. Agora a página sai sozinha (LIMIT barato) e o total
// vem de UMA agregação por status (get_campaign_stats, índice (campaign_id, status)) — a mesma conta dos cards de
// métricas. Só vale quando o filtro é por status; busca por contato, "respondidos" e "aguardando confirmação" têm
// filtros próprios e continuam contando exato (conjuntos pequenos).

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCampaignStatusCounts } from "@/lib/disparador/campaign-status-counts";

/** Soma das contagens dos `statuses` (null = todos). `null` no retorno = não foi possível contar (use o caminho exato). */
export async function totalFromStatusCounts(
  db: Pick<SupabaseClient, "rpc" | "from">,
  campaignId: string,
  statuses: readonly string[] | null,
): Promise<number | null> {
  const counts = await loadCampaignStatusCounts(db, campaignId);
  if (!counts) return null;
  const wanted = statuses ? new Set(statuses) : null;
  let total = 0;
  for (const [status, qty] of Object.entries(counts)) {
    if (!wanted || wanted.has(status)) total += qty;
  }
  return total;
}
