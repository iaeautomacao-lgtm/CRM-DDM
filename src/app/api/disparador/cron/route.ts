import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  processQueueItem,
  checkWithinWindow,
  sendCampaignCallback,
  markQueueError,
  type QueueItem,
  type Campaign,
} from "@/lib/disparador/processQueue";
import { startCampaign } from "@/lib/disparador/startCampaign";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { writeLog } from "@/lib/logger";


function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    })
  );
}

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

    const fetchSize = readPositiveIntEnv("DISPATCH_FETCH_SIZE", 100, 500);
    const concurrency = readPositiveIntEnv("DISPATCH_CONCURRENCY", 10, 50);
    const lockTtlSeconds = readPositiveIntEnv(
      "DISPATCH_CRON_LOCK_TTL_SECONDS",
      600,
      3600
    );
    const cronRunId = randomUUID();
    const memoryBefore = process.memoryUsage();
    const startedAt = Date.now();
    let lockAcquired = false;

    // Lock distribuido no Postgres (migration 113). Se a migration ainda
    // nao estiver aplicada, o cron continua operando com o claim atomico
    // individual existente, mas registra claramente que esta sem o lock.
    try {
      const { data: acquired, error: lockError } = await supabaseAdmin().rpc(
        "try_acquire_cron_lock",
        {
          p_name: "disparador_cron",
          p_owner_id: cronRunId,
          p_ttl_seconds: lockTtlSeconds,
        }
      );

      if (lockError) {
        console.error(
          "[Cron] Lock distribuido indisponivel (migration 113 aplicada?):",
          lockError.message
        );
      } else if (!acquired) {
        return NextResponse.json({
          status: "already_running",
          cron_run_id: cronRunId,
        });
      } else {
        lockAcquired = true;
      }
    } catch (lockErr: any) {
      console.error(
        "[Cron] Falha ao adquirir lock distribuido:",
        lockErr?.message || lockErr
      );
    }

    try {

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
        // Itens presos em 'enviando' — se o processo cair entre
        // claimItemAtomically (marca 'enviando') e a escrita final de
        // sucesso/erro, o item ficava travado ali pra sempre: o claim só
        // reivindica status='agendado' (nunca mais pega esse item de
        // volta), retry_transient_queue_errors (migration 089) só cobre
        // status='erro', e o check de "campanha completa" abaixo só
        // conta 'agendado' e 'erro' elegível — um item 'enviando' órfão é
        // invisível pra ele, então a campanha fecha como "encerrada" com
        // esse item permanentemente pendurado, fora de qualquer métrica.
        // 5 minutos é seguro: claim + envio + escrita final não passam de
        // 1-2 minutos em condições normais. Depende de updated_at
        // refletir o momento do claim, não do enfileiramento — ver
        // claimItemAtomically em processQueue.ts, que agora carimba essa
        // coluna explicitamente por não haver trigger mantendo ela.
        const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { error: staleResetError } = await supabaseAdmin()
          .from("disp_message_queue")
          .update({ status: "agendado", scheduled_at: new Date().toISOString() })
          .eq("campaign_id", campaign.id)
          .eq("status", "enviando")
          .lt("updated_at", staleThreshold);

        if (staleResetError) {
          console.error(
            `[Cron] Falha ao resetar itens presos em 'enviando' da campanha ${campaign.id}:`,
            staleResetError.message
          );
        }

        const hasWindow =
          campaign.janela_inicio &&
          campaign.janela_fim &&
          campaign.janela_inicio !== "00:00" &&
          campaign.janela_fim !== "23:59";

        if (hasWindow && !checkWithinWindow(campaign.janela_inicio!, campaign.janela_fim!)) {
          continue;
        }

        // limite_por_hora usa janela movel de 60 minutos. Alem de
        // bloquear quando o limite ja foi atingido, reduzimos o fetch para
        // a capacidade RESTANTE — evita 95/100 liberar um lote de 20.
        const limiteHora = Math.max(0, campaign.limite_por_hora ?? 0);
        let remainingHourlyCapacity = Number.POSITIVE_INFINITY;

        if (limiteHora > 0) {
          const umaHoraAtras = new Date(Date.now() - 3600 * 1000).toISOString();
          const { count, error: hourlyLimitError } = await supabaseAdmin()
            .from("disp_message_queue")
            .select("id", { count: "exact", head: true })
            .eq("campaign_id", campaign.id)
            .in("status", ["enviado", "entregue", "lido"])
            .gte("sent_at", umaHoraAtras);

          if (hourlyLimitError) {
            // Fail closed: se nao conseguimos medir o rate limit, nao
            // liberamos um lote potencialmente acima do configurado.
            console.error(
              `[Cron] Falha ao calcular limite_por_hora da campanha ${campaign.id}:`,
              hourlyLimitError.message
            );
            continue;
          }

          remainingHourlyCapacity = Math.max(0, limiteHora - (count ?? 0));
          if (remainingHourlyCapacity === 0) {
            console.log(
              `[Cron] Campanha ${campaign.id} atingiu limite_por_hora (${limiteHora}) — pulando este tick.`
            );
            continue;
          }
        }

        // batch_size continua sendo uma regra funcional da campanha.
        // fetchSize limita quantos candidatos um tick materializa e
        // concurrency limita quantos processQueueItem rodam ao mesmo tempo.
        const batchSize = Math.max(1, campaign.batch_size ?? 1);
        const fetchLimit = Math.max(
          1,
          Math.min(batchSize, fetchSize, remainingHourlyCapacity)
        );

        const now = new Date().toISOString();
        const { data: items, error: queryError } = await supabaseAdmin()
          .from("disp_message_queue")
          .select("*, contacts(name, phone, company)")
          .eq("campaign_id", campaign.id)
          .eq("status", "agendado")
          .lte("scheduled_at", now)
          .order("scheduled_at", { ascending: true })
          .limit(fetchLimit);

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

          // Itens 'erro' com erro_permanente=false e tentativas<5 ainda
          // são candidatos a retry_transient_queue_errors (migration 089,
          // chamada no passo 1.5 acima) — são a MESMA condição de
          // elegibilidade daquela RPC. Sem essa contagem aqui, uma
          // campanha com só esses itens "sobrando" (0 agendado) encerrava
          // como concluída, e a RPC nunca mais reagenda itens de campanha
          // que não está 'em_execucao' — os itens ficavam presos em
          // 'erro' pra sempre, mesmo não sendo erro permanente e ainda
          // tendo tentativas disponíveis. Tolerante à coluna
          // erro_permanente não existir (migration 075 não aplicada,
          // mesmo padrão de markQueueError em processQueue.ts): erro na
          // query não deve travar o cron, só faz essa contagem cair pra 0
          // (comportamento anterior a este fix).
          let pendingRetryableErrors = 0;
          const { count: retryableCount, error: retryableError } = await supabaseAdmin()
            .from("disp_message_queue")
            .select("*", { count: "exact", head: true })
            .eq("campaign_id", campaign.id)
            .eq("status", "erro")
            .eq("erro_permanente", false)
            .lt("tentativas", 5);
          if (retryableError) {
            console.error(
              `[Cron] Falha ao contar itens de erro retry-elegíveis da campanha ${campaign.id} (coluna erro_permanente pode não existir):`,
              retryableError.message
            );
          } else {
            pendingRetryableErrors = retryableCount ?? 0;
          }

          if (count === 0 && pendingRetryableErrors === 0) {
            console.log(`[Cron] Campaign ${campaign.id} completed.`);
            await supabaseAdmin()
              .from("campaigns")
              .update({ status: "encerrada" })
              .eq("id", campaign.id);
            // Recalcula campaign_metrics do zero a partir de
            // disp_message_queue (migration 112) antes do callback —
            // corrige qualquer drift acumulado por increment_campaign_metric
            // ter perdido algum evento ao longo da campanha. Aguardado
            // (não fire-and-forget) pra garantir que sendCampaignCallback
            // logo abaixo já leia métricas frescas.
            const { error: recalcError } = await supabaseAdmin().rpc(
              "recalculate_campaign_metrics",
              { p_campaign_id: campaign.id }
            );
            if (recalcError) {
              console.error(
                `[Cron] Falha ao recalcular métricas da campanha ${campaign.id}:`,
                recalcError.message
              );
            }
            void sendCampaignCallback(campaign.id);
          }
          continue;
        }

        console.log(
          `[Cron] Processing ${items.length} item(s) for campaign ${campaign.id} (batch_size=${batchSize}, fetch_limit=${fetchLimit}, concurrency=${concurrency})`
        );

        // Backpressure real: o tamanho do batch/fetch nao cria o mesmo
        // numero de Promises simultaneas. No maximo "concurrency" itens
        // ficam em processamento ao mesmo tempo neste tick.
        await runWithConcurrency(
          items as QueueItem[],
          concurrency,
          async (item) => {
            try {
              const result = await processQueueItem(item, campaign);
              if (result.outcome === "error") {
                console.error(`[Cron] Item ${item.id} error:`, result.error);
              }
            } catch (itemErr: any) {
              console.error(`[Cron] Exception on item ${item.id}:`, itemErr.message);
              await markQueueError(
                item.id,
                itemErr.message || String(itemErr),
                false,
                item.campaign_id,
                (item.tentativas || 0) + 1
              );
            }
          }
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
      cron_run_id: cronRunId,
      fetch_size: fetchSize,
      concurrency,
      results,
    });
    } finally {
      if (lockAcquired) {
        const { error: releaseError } = await supabaseAdmin().rpc(
          "release_cron_lock",
          {
            p_name: "disparador_cron",
            p_owner_id: cronRunId,
          }
        );
        if (releaseError) {
          console.error("[Cron] Falha ao liberar lock distribuido:", releaseError.message);
        }
      }

      const memoryAfter = process.memoryUsage();
      console.log("[Cron] Tick finalizado", {
        cron_run_id: cronRunId,
        duration_ms: Date.now() - startedAt,
        fetch_size: fetchSize,
        concurrency,
        rss_before: memoryBefore.rss,
        rss_after: memoryAfter.rss,
        heap_used_before: memoryBefore.heapUsed,
        heap_used_after: memoryAfter.heapUsed,
      });
    }
  } catch (err: any) {
    console.error("[Cron] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
