import { supabaseAdmin } from "@/lib/disparador/admin-client";
import {
  processQueueItem,
  checkWithinWindow,
  type QueueItem,
  type Campaign,
} from "@/lib/disparador/processQueue";

// KNOWN LOCAL-TEST RISK: o worker de produção (branch main) compete pelos
// mesmos itens de disp_message_queue. Um item criado em dev pode ser
// processado pelo worker de prod antes deste processo — confirmado em
// 2026-07-23. Só confirme que o código local rodou verificando o log
// "[Queue Worker] Processing item ..." neste processo.

let isWorkerRunning = false;

export function ensureQueueWorkerRunning() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  console.log("[Queue Worker] Global background queue worker initialized.");

  setInterval(async () => {
    try {
      const { data: activeCampaigns } = await supabaseAdmin()
        .from("campaigns")
        .select("id, status, janela_inicio, janela_fim")
        .eq("status", "em_execucao");

      if (!activeCampaigns?.length) return;

      for (const campaign of activeCampaigns as Campaign[]) {
        try {
          const hasWindow =
            campaign.janela_inicio &&
            campaign.janela_fim &&
            campaign.janela_inicio !== "00:00" &&
            campaign.janela_fim !== "23:59";

          if (hasWindow && !checkWithinWindow(campaign.janela_inicio!, campaign.janela_fim!)) {
            continue;
          }

          const now = new Date().toISOString();
          const { data: item, error: queryError } = await supabaseAdmin()
            .from("disp_message_queue")
            .select("*, contacts(name, phone, company)")
            .eq("campaign_id", campaign.id)
            .eq("status", "agendado")
            .lte("scheduled_at", now)
            .order("scheduled_at", { ascending: true })
            .limit(1)
            .maybeSingle();

          if (queryError) {
            console.error("[Queue Worker] Query error:", queryError.message);
            continue;
          }

          if (!item) {
            const { count } = await supabaseAdmin()
              .from("disp_message_queue")
              .select("*", { count: "exact", head: true })
              .eq("campaign_id", campaign.id)
              .eq("status", "agendado");

            if (count === 0) {
              console.log(`[Queue Worker] Campaign ${campaign.id} completed.`);
              await supabaseAdmin()
                .from("campaigns")
                .update({ status: "encerrada" })
                .eq("id", campaign.id);
            }
            continue;
          }

          console.log(`[Queue Worker] Processing item ${item.id} for campaign ${campaign.id}`);

          try {
            const result = await processQueueItem(item as QueueItem, campaign);
            if (result.outcome === "error") {
              console.error(`[Queue Worker] Item ${item.id} error:`, result.error);
            }
          } catch (itemErr: any) {
            console.error(`[Queue Worker] Exception on item ${item.id}:`, itemErr.message);
            await supabaseAdmin()
              .from("disp_message_queue")
              .update({
                status: "erro",
                erro: itemErr.message || String(itemErr),
                tentativas: (item.tentativas || 0) + 1,
              })
              .eq("id", item.id);
          }
        } catch (campaignErr: any) {
          console.error(`[Queue Worker] Error on campaign ${campaign.id}:`, campaignErr.message);
        }
      }
    } catch (err: any) {
      console.error("[Queue Worker] Interval error:", err);
    }
  }, 5000);
}
