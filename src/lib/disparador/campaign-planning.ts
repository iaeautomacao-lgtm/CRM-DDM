import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCampaignAudience } from "./audience";
import { loadBlacklistKeySet } from "./blacklist-keys";
import { phoneKey } from "./phone-key";

export interface PlannedCampaignMetrics {
  total_contatos: number;
}

/**
 * Calcula e persiste o público elegível de uma campanha antes do primeiro
 * disparo. Assim campanhas agendadas já conseguem mostrar quantidade e
 * previsão sem esperar a fila ser montada.
 *
 * total_contatos mantém a mesma semântica do startCampaign: contatos que
 * podem entrar na fila, já excluindo blacklist. Quando o envio realmente
 * começa, startCampaign recalcula e sobrescreve esse valor com a fila real.
 */
export async function syncCampaignPlannedMetrics(
  db: SupabaseClient,
  accountId: string,
  campaignId: string
): Promise<
  | { ok: true; metrics: PlannedCampaignMetrics }
  | { ok: false; error: string }
> {
  const { data: campaign, error } = await db
    .from("campaigns")
    .select("id,account_id,import_draft_id,tags_filtro,audience_mode")
    .eq("id", campaignId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!campaign) return { ok: false, error: "Campanha não encontrada" };

  const audience = await loadCampaignAudience(db, accountId, campaign, "id,phone");
  if (!audience.ok) return audience;

  const blacklist = await loadBlacklistKeySet(db);
  const eligibleIds = new Set<string>();
  for (const contact of audience.contacts) {
    if (typeof contact.phone === "string" && blacklist.has(phoneKey(contact.phone))) continue;
    if (typeof contact.id === "string") eligibleIds.add(contact.id);
  }

  const metrics = { total_contatos: eligibleIds.size };
  const { error: metricsError } = await db.from("campaign_metrics").upsert(
    {
      campaign_id: campaignId,
      account_id: accountId,
      total_contatos: metrics.total_contatos,
    },
    { onConflict: "campaign_id" }
  );
  if (metricsError) return { ok: false, error: metricsError.message };
  return { ok: true, metrics };
}
