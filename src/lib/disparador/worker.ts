import { supabaseAdmin } from "@/lib/disparador/admin-client";
import {
  processQueueItem,
  checkWithinWindow,
  sendCampaignCallback,
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
  // Worker em memória desativado — processamento centralizado no cron
  // (ver /api/disparador/cron/route.ts). Phusion Passenger não mantém
  // setInterval entre requisições, então este setInterval nunca era
  // garantido de continuar rodando em produção. Resto da função mantido
  // abaixo (inalcançável) só como referência do que o cron replica hoje.
  return;

  // eslint-disable-next-line no-unreachable
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  console.log("[Queue Worker] Global background queue worker initialized.");

  setInterval(async () => {
    try {
      const { data: activeCampaigns } = await supabaseAdmin()
        .from("campaigns")
        .select("id, status, janela_inicio, janela_fim, batch_size, batch_pause_seconds, limite_por_hora")
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

          // Migration 078 — limite_por_hora existia no schema mas nunca era
          // lido; agora bloqueia novos claims quando a campanha já enviou
          // (enviado/entregue/lido) esse tanto na última hora.
          const limiteHora = campaign.limite_por_hora ?? 0;
          if (limiteHora > 0) {
            const umaHoraAtras = new Date(Date.now() - 3600 * 1000).toISOString();
            const { count } = await supabaseAdmin()
              .from("disp_message_queue")
              .select("*", { count: "exact", head: true })
              .eq("campaign_id", campaign.id)
              .in("status", ["enviado", "entregue", "lido"])
              .gte("sent_at", umaHoraAtras);

            if ((count ?? 0) >= limiteHora) {
              console.log(`[Queue Worker] Campaign ${campaign.id} hit limite_por_hora (${limiteHora}) — skipping this tick.`);
              continue;
            }
          }

          // batch_size itens são buscados aqui (candidatos, ainda não
          // reivindicados) — a reivindicação atômica de cada um continua
          // dentro de processQueueItem (claimItemAtomically), exatamente
          // como no comportamento de item único anterior. Não usamos
          // claimQueueItem() aqui porque ela já marca status='enviando' —
          // chamá-la e depois passar o item para processQueueItem faria o
          // claim interno deste (que exige status='agendado') falhar
          // sempre, travando o item em 'enviando' para sempre.
          const batchSize = Math.max(1, campaign.batch_size ?? 1);

          const now = new Date().toISOString();
          const { data: items, error: queryError } = await supabaseAdmin()
            .from("disp_message_queue")
            .select("*, contacts(name, phone, company)")
            .eq("campaign_id", campaign.id)
            .eq("status", "agendado")
            .lte("scheduled_at", now)
            .order("scheduled_at", { ascending: true })
            .limit(batchSize);

          if (queryError) {
            console.error("[Queue Worker] Query error:", queryError.message);
            continue;
          }

          if (!items?.length) {
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
              // Dispara callback se configurado (fire-and-forget, não bloqueia o worker)
              void sendCampaignCallback(campaign.id);
            }
            continue;
          }

          console.log(`[Queue Worker] Processing ${items.length} item(s) for campaign ${campaign.id} (batch_size=${batchSize})`);

          // Processa o lote em paralelo — cada item ainda passa pelo claim
          // atômico individual dentro de processQueueItem, então não há
          // risco de double-send mesmo com N chamadas simultâneas.
          await Promise.all(
            (items as QueueItem[]).map(async (item) => {
              try {
                const result = await processQueueItem(item, campaign);
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
            })
          );

          // Checagem de "campanha terminou" já roda no próximo tick (bloco
          // `!items?.length` acima) — nunca durante o Promise.all, então
          // itens ainda em voo neste lote não fazem a campanha ser
          // encerrada prematuramente.

          // Pausa entre lotes — só espera quando o lote saiu cheio (sinal de
          // que provavelmente há mais itens agendados esperando); um lote
          // parcial já significa que a fila da campanha esvaziou por agora.
          const pauseMs = (campaign.batch_pause_seconds ?? 0) * 1000;
          if (pauseMs > 0 && items.length === batchSize) {
            await new Promise((r) => setTimeout(r, pauseMs));
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
