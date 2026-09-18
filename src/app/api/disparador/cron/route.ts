import { NextResponse } from "next/server";
import {
  processQueueItem,
  checkWithinWindow,
  sendCampaignCallback,
  type QueueItem,
  type Campaign,
} from "@/lib/disparador/processQueue";
import { startCampaign } from "@/lib/disparador/startCampaign";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { writeLog } from "@/lib/logger";

// Consumidor principal (e único) da fila do Disparador. Phusion Passenger
// não mantém setInterval em memória entre requisições, então o antigo
// worker.ts (ver src/lib/disparador/worker.ts, agora desativado) nunca era
// garantido de rodar em produção — só o crontab externo, que chama esta
// rota a cada minuto via x-cron-secret, é confiável. Cada invocação é
// stateless: processa um tick inteiro (auto-start + até batch_size itens
// por campanha em execução) e retorna.
export async function POST(request: Request) {
  try {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
      return NextResponse.json({ error: "cron not configured" }, { status: 503 });
    }
    const supplied = request.headers.get("x-cron-secret");
    if (supplied !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 1. Auto-start de campanhas agendadas cujo horário chegou — direto via
    // startCampaign()/supabaseAdmin(), sem round-trip HTTP pro endpoint
    // /start (elimina a necessidade do header x-internal-cron). A
    // resolução de account_id replica exatamente o que o branch
    // isInternalCall de start/route.ts fazia antes desta refatoração.
    const nowStr = new Date().toISOString();
    const { data: campanhasParaIniciar } = await supabaseAdmin()
      .from("campaigns")
      .select("id, created_by")
      .eq("status", "agendado")
      .lte("agendamento", nowStr);

    for (const campanha of campanhasParaIniciar ?? []) {
      try {
        if (!campanha.created_by) {
          console.error(`[Cron] Campanha ${campanha.id} sem created_by — não é possível resolver a conta.`);
          continue;
        }
        const { data: creatorProfile } = await supabaseAdmin()
          .from("profiles")
          .select("account_id")
          .eq("user_id", campanha.created_by)
          .maybeSingle();
        if (!creatorProfile?.account_id) {
          console.error(`[Cron] Criador da campanha ${campanha.id} não está vinculado a uma conta.`);
          continue;
        }

        const result = await startCampaign(campanha.id, creatorProfile.account_id);
        if (result.ok) {
          console.log(`[Cron] Campanha agendada ${campanha.id} iniciada automaticamente (${result.enqueued} itens enfileirados).`);
        } else {
          console.error(`[Cron] Erro ao iniciar campanha agendada ${campanha.id}:`, result.error);
        }
      } catch (err: any) {
        console.error(`[Cron] Erro ao iniciar campanha agendada ${campanha.id}:`, err.message);
      }
    }

    // 1.5. Retry de erros transitórios — itens que falharam com erro NÃO
    // permanente (rede instável, 5xx da Meta/WAHA, etc.) ficavam presos em
    // status='erro' pra sempre: o claim só seleciona status='agendado', e
    // nada reagendava um item de volta de 'erro'. RPC wacrm.
    // retry_transient_queue_errors (migration 089) reagenda com backoff
    // exponencial, uma vez por tick, antes do loop de processamento
    // abaixo — não mexe no claim/processamento em si. Tolerante à
    // migration não aplicada (mesmo padrão de claimQueueItem em
    // processQueue.ts): se a RPC ainda não existir, só loga e segue o
    // tick normalmente.
    try {
      const { data: retriedCount, error: retryError } = await supabaseAdmin().rpc(
        "retry_transient_queue_errors"
      );
      if (retryError) throw retryError;
      if ((retriedCount ?? 0) > 0) {
        console.log(`[Cron] ${retriedCount} item(ns) de erro transitório reagendado(s) para retry.`);
        void writeLog({
          level: "info",
          source: "disparador",
          event: "queue_transient_errors_retried",
          message: "Itens de erro transitório reagendados para retry",
          payload: { count: retriedCount },
        });
      }
    } catch (err: any) {
      console.error("[Cron] Falha ao rodar retry_transient_queue_errors:", err.message || err);
    }

    // 2. Processar itens da fila para campanhas em execução — mesma lógica
    // que existia em worker.ts (setInterval, agora desativado), só que
    // stateless: um tick por invocação do cron, sem loop em memória.
    const { data: campanhasAtivas } = await supabaseAdmin()
      .from("campaigns")
      .select("id, status, janela_inicio, janela_fim, batch_size, batch_pause_seconds, limite_por_hora")
      .eq("status", "em_execucao");

    const results: Array<{ campaign_id: string; processed: number }> = [];

    for (const campaign of (campanhasAtivas ?? []) as Campaign[]) {
      try {
        const hasWindow =
          campaign.janela_inicio &&
          campaign.janela_fim &&
          campaign.janela_inicio !== "00:00" &&
          campaign.janela_fim !== "23:59";

        if (hasWindow && !checkWithinWindow(campaign.janela_inicio!, campaign.janela_fim!)) {
          continue;
        }

        // limite_por_hora — bloqueia novos claims quando a campanha já
        // enviou (enviado/entregue/lido) esse tanto na última hora.
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
            console.log(`[Cron] Campanha ${campaign.id} atingiu limite_por_hora (${limiteHora}) — pulando este tick.`);
            continue;
          }
        }

        // batch_size itens são buscados aqui (candidatos, ainda não
        // reivindicados) — a reivindicação atômica de cada um continua
        // dentro de processQueueItem (claimItemAtomically).
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
          console.error(`[Cron] Query error for campaign ${campaign.id}:`, queryError.message);
          continue;
        }

        if (!items?.length) {
          const { count } = await supabaseAdmin()
            .from("disp_message_queue")
            .select("*", { count: "exact", head: true })
            .eq("campaign_id", campaign.id)
            .eq("status", "agendado");

          if (count === 0) {
            console.log(`[Cron] Campaign ${campaign.id} completed.`);
            await supabaseAdmin()
              .from("campaigns")
              .update({ status: "encerrada" })
              .eq("id", campaign.id);
            void sendCampaignCallback(campaign.id);
          }
          continue;
        }

        console.log(`[Cron] Processing ${items.length} item(s) for campaign ${campaign.id} (batch_size=${batchSize})`);

        // Processa o lote em paralelo — cada item ainda passa pelo claim
        // atômico individual dentro de processQueueItem, então não há
        // risco de double-send mesmo com N chamadas simultâneas, nem com
        // o crontab externo sobrepondo invocações.
        await Promise.all(
          (items as QueueItem[]).map(async (item) => {
            try {
              const result = await processQueueItem(item, campaign);
              if (result.outcome === "error") {
                console.error(`[Cron] Item ${item.id} error:`, result.error);
              }
            } catch (itemErr: any) {
              console.error(`[Cron] Exception on item ${item.id}:`, itemErr.message);
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

        results.push({ campaign_id: campaign.id, processed: items.length });

        // Nota: batch_pause_seconds NÃO é aplicado aqui como pausa síncrona
        // (diferente de worker.ts) — segurar a resposta HTTP do cron por
        // até batch_pause_seconds segundos não vale a pena; o crontab já
        // roda a cada minuto, o que naturalmente espaça os lotes.
      } catch (campaignErr: any) {
        console.error(`[Cron] Error on campaign ${campaign.id}:`, campaignErr.message);
      }
    }

    return NextResponse.json({
      status: results.length > 0 ? "processed" : "idle",
      results,
    });
  } catch (err: any) {
    console.error("[Cron] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
