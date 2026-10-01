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
  worker: (item: T) => Promise<void>,
  shouldStartNext: () => boolean = () => true
): Promise<void> {
  if (items.length === 0) return;

  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (shouldStartNext()) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    })
  );
}

function interleaveGroups<T>(groups: T[][]): T[] {
  const result: T[] = [];
  const maxLength = groups.reduce((max, group) => Math.max(max, group.length), 0);

  for (let index = 0; index < maxLength; index++) {
    for (const group of groups) {
      if (index < group.length) result.push(group[index]);
    }
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Limite GLOBAL deste processo/tick. N campanhas ativas compartilham
    // este mesmo pool — nunca vira N * concurrency.
    const concurrency = readPositiveIntEnv("DISPATCH_CONCURRENCY", 10, 50);
    // Mantém a request abaixo do minuto do crontab e deixa folga pro
    // Passenger liberar recursos antes do próximo tick.
    const tickBudgetMs = readPositiveIntEnv(
      "DISPATCH_TICK_BUDGET_MS",
      40_000,
      50_000
    );
    // Quantos candidatos podem ser materializados por rodada somando TODAS
    // as campanhas. O pool global continua sendo o limitador de execução.
    const roundMaxItems = readPositiveIntEnv(
      "DISPATCH_ROUND_MAX_ITEMS",
      150,
      500
    );
    const idlePollMs = readPositiveIntEnv(
      "DISPATCH_IDLE_POLL_MS",
      500,
      2_000
    );
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

    // 2. Drenar a fila dentro de um orçamento de tempo. Diferente da
    // implementação anterior, não fazemos apenas UMA rodada por campanha e
    // depois esperamos o próximo minuto. Enquanto houver budget, buscamos
    // novos itens elegíveis e reutilizamos o mesmo pool GLOBAL.
    const { data: campanhasAtivas } = await supabaseAdmin()
      .from("campaigns")
      .select("id, status, janela_inicio, janela_fim, batch_size, batch_pause_seconds, limite_por_hora")
      .eq("status", "em_execucao");

    type CampaignState = {
      campaign: Campaign;
      batchSize: number;
      remainingHourlyCapacity: number;
      enabled: boolean;
    };

    type WorkItem = {
      item: QueueItem;
      state: CampaignState;
    };

    type CampaignStats = {
      campaign_id: string;
      processed: number;
      sent: number;
      error: number;
      deferred: number;
      blocked: number;
    };

    const states: CampaignState[] = [];
    const resultsByCampaign = new Map<string, CampaignStats>();

    // Preparação feita uma vez por tick: stale recovery, janela e quota
    // horária. A quota restante é decrementada em memória a cada envio
    // bem-sucedido nas rodadas seguintes, evitando um COUNT por rodada.
    for (const campaign of (campanhasAtivas ?? []) as Campaign[]) {
      try {
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

        if (
          hasWindow &&
          !checkWithinWindow(campaign.janela_inicio!, campaign.janela_fim!)
        ) {
          continue;
        }

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

        states.push({
          campaign,
          batchSize: Math.max(1, campaign.batch_size ?? 1),
          remainingHourlyCapacity,
          enabled: true,
        });
        resultsByCampaign.set(campaign.id, {
          campaign_id: campaign.id,
          processed: 0,
          sent: 0,
          error: 0,
          deferred: 0,
          blocked: 0,
        });
      } catch (campaignErr: any) {
        console.error(
          `[Cron] Falha ao preparar campanha ${campaign.id}:`,
          campaignErr?.message || campaignErr
        );
      }
    }

    const drainDeadline = startedAt + tickBudgetMs;
    let round = 0;
    let roundOffset = 0;
    let idleRounds = 0;
    let totalProcessed = 0;

    while (Date.now() < drainDeadline - 1_000) {
      const activeStates = states.filter(
        (state) =>
          state.enabled &&
          (state.remainingHourlyCapacity > 0 ||
            !Number.isFinite(state.remainingHourlyCapacity))
      );
      if (activeStates.length === 0) break;

      // Divide o budget de candidatos de forma justa entre as campanhas
      // desta rodada. Ex.: roundMax=150 e 3 campanhas => até 50 de cada.
      // Com 30 campanhas => até 5 de cada. batch_size e fetchSize continuam
      // sendo tetos adicionais.
      const fairShare = Math.max(
        1,
        Math.floor(roundMaxItems / Math.max(1, activeStates.length))
      );
      let remainingRoundBudget = roundMaxItems;
      let visited = 0;
      const groups: WorkItem[][] = [];

      const orderedStates = [
        ...activeStates.slice(roundOffset % activeStates.length),
        ...activeStates.slice(0, roundOffset % activeStates.length),
      ];

      for (const state of orderedStates) {
        if (remainingRoundBudget <= 0) break;
        if (Date.now() >= drainDeadline - 1_000) break;

        visited += 1;

        const hourlyCap = Number.isFinite(state.remainingHourlyCapacity)
          ? state.remainingHourlyCapacity
          : Number.MAX_SAFE_INTEGER;

        const fetchLimit = Math.max(
          1,
          Math.min(
            state.batchSize,
            fetchSize,
            fairShare,
            hourlyCap,
            remainingRoundBudget
          )
        );

        const { data: items, error: queryError } = await supabaseAdmin()
          .from("disp_message_queue")
          .select("*, contacts(name, phone, company)")
          .eq("campaign_id", state.campaign.id)
          .eq("status", "agendado")
          .lte("scheduled_at", new Date().toISOString())
          .order("scheduled_at", { ascending: true })
          .limit(fetchLimit);

        if (queryError) {
          console.error(
            `[Cron] Query error for campaign ${state.campaign.id}:`,
            queryError.message
          );
          continue;
        }

        if (!items?.length) continue;

        const group = (items as QueueItem[]).map((item) => ({
          item,
          state,
        }));
        groups.push(group);
        remainingRoundBudget -= group.length;
      }

      if (activeStates.length > 0) {
        roundOffset =
          (roundOffset + Math.max(1, visited)) % activeStates.length;
      }

      const work = interleaveGroups(groups);

      if (work.length === 0) {
        // Balanceado agenda os próximos itens 1-3s à frente. Em vez de
        // encerrar imediatamente e desperdiçar o resto do minuto, fazemos
        // polls curtos. O teto de 8 rounds ociosos evita manter uma request
        // viva até o deadline quando não há mais nada próximo de ficar due.
        idleRounds += 1;
        if (idleRounds >= 8) break;

        const waitMs = Math.min(
          idlePollMs,
          Math.max(0, drainDeadline - Date.now() - 1_000)
        );
        if (waitMs <= 0) break;
        await sleep(waitMs);
        continue;
      }

      idleRounds = 0;
      round += 1;

      console.log(
        `[Cron] Round ${round}: ${work.length} candidato(s), ${activeStates.length} campanha(s), concurrency global=${concurrency}`
      );

      // ÚNICO pool de concorrência do tick. Mesmo que existam dezenas de
      // campanhas, nunca há mais que DISPATCH_CONCURRENCY
      // processQueueItem simultâneos neste processo.
      await runWithConcurrency(
        work,
        concurrency,
        async ({ item, state }) => {
          const stats = resultsByCampaign.get(state.campaign.id)!;

          try {
            const result = await processQueueItem(item, state.campaign);
            stats.processed += 1;
            totalProcessed += 1;

            if (result.outcome === "sent") {
              stats.sent += 1;
              if (Number.isFinite(state.remainingHourlyCapacity)) {
                state.remainingHourlyCapacity = Math.max(
                  0,
                  state.remainingHourlyCapacity - 1
                );
              }
            } else if (result.outcome === "error") {
              stats.error += 1;
              console.error(`[Cron] Item ${item.id} error:`, result.error);
            } else if (result.outcome === "blocked") {
              stats.blocked += 1;
            } else {
              stats.deferred += 1;
            }
          } catch (itemErr: any) {
            stats.processed += 1;
            stats.error += 1;
            totalProcessed += 1;
            console.error(`[Cron] Exception on item ${item.id}:`, itemErr.message);
            await markQueueError(
              item.id,
              itemErr.message || String(itemErr),
              false,
              item.campaign_id,
              (item.tentativas || 0) + 1
            );
          }
        },
        // Não inicia trabalho novo nos últimos 5s do budget. Um request
        // externo que já começou pode terminar depois disso (timeouts
        // próprios protegem WAHA/Meta/OpenAI), mas não criamos novas ondas.
        () => Date.now() < drainDeadline - 5_000
      );
    }

    // Completion sweep uma vez no final, não a cada rodada. Inclui
    // 'enviando' para não encerrar uma campanha que ainda tenha trabalho
    // em andamento por alguma execução anterior.
    for (const state of states) {
      try {
        const { count: pendingCount, error: pendingError } = await supabaseAdmin()
          .from("disp_message_queue")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", state.campaign.id)
          .in("status", ["agendado", "enviando"]);

        if (pendingError) {
          console.error(
            `[Cron] Falha ao contar pendências da campanha ${state.campaign.id}:`,
            pendingError.message
          );
          continue;
        }

        let pendingRetryableErrors = 0;
        const { count: retryableCount, error: retryableError } =
          await supabaseAdmin()
            .from("disp_message_queue")
            .select("id", { count: "exact", head: true })
            .eq("campaign_id", state.campaign.id)
            .eq("status", "erro")
            .eq("erro_permanente", false)
            .lt("tentativas", 5);

        if (retryableError) {
          console.error(
            `[Cron] Falha ao contar erros retry-elegíveis da campanha ${state.campaign.id}:`,
            retryableError.message
          );
        } else {
          pendingRetryableErrors = retryableCount ?? 0;
        }

        if ((pendingCount ?? 0) === 0 && pendingRetryableErrors === 0) {
          console.log(`[Cron] Campaign ${state.campaign.id} completed.`);
          await supabaseAdmin()
            .from("campaigns")
            .update({ status: "encerrada" })
            .eq("id", state.campaign.id);

          const { error: recalcError } = await supabaseAdmin().rpc(
            "recalculate_campaign_metrics",
            { p_campaign_id: state.campaign.id }
          );
          if (recalcError) {
            console.error(
              `[Cron] Falha ao recalcular métricas da campanha ${state.campaign.id}:`,
              recalcError.message
            );
          }
          void sendCampaignCallback(state.campaign.id);
        }
      } catch (campaignErr: any) {
        console.error(
          `[Cron] Completion sweep falhou para ${state.campaign.id}:`,
          campaignErr?.message || campaignErr
        );
      }
    }

    const results = Array.from(resultsByCampaign.values()).filter(
      (result) => result.processed > 0
    );

    return NextResponse.json({
      status: results.length > 0 ? "processed" : "idle",
      cron_run_id: cronRunId,
      fetch_size: fetchSize,
      concurrency,
      tick_budget_ms: tickBudgetMs,
      round_max_items: roundMaxItems,
      rounds: round,
      total_processed: totalProcessed,
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
        tick_budget_ms: tickBudgetMs,
        round_max_items: roundMaxItems,
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
