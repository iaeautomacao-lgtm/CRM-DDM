import { NextResponse } from "next/server";
import { registerAuditActor } from '@/lib/audit/context'
import { randomUUID } from 'node:crypto';
import { drainCallbackOutbox } from '@/lib/disparador/callback-outbox';
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import {
  processQueueItem,
  checkWithinWindow,
  type QueueItem,
  type Campaign,
} from "@/lib/disparador/processQueue";
import { processWithConcurrency } from "@/lib/disparador/concurrency";
import { startCampaign } from "@/lib/disparador/startCampaign";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

// ============================================================
// /api/disparador/cron — motor stateless do disparador.
//
// GET  → só diagnóstico (health check). Não tem efeitos colaterais.
// POST → executa um tick: prepara campanhas agendadas, consome a fila e
//        entrega callbacks. Os agendadores externos devem usar POST.
//
// Ambos exigem o header `x-cron-secret` == CRON_SECRET. Sem a variável
// configurada a rota responde 503 (fail-closed), nunca libera o acesso.
//
// Toda a coordenação de concorrência fica no banco (migrations 118–125):
// lock do cron com lease, reserva de cadência por campanha, claim por item
// com quota/concorrência por canal. Assim, ticks sobrepostos ou várias
// instâncias do Passenger não geram envio duplicado.
// ============================================================

function authorize(request: Request): NextResponse | null {
  if (!process.env.CRON_SECRET)
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// Diagnóstico apenas: não inicia campanhas, não consome fila, não faz
// retry nem emite callbacks. Antes o GET executava o tick inteiro, e cada
// health check (monitor, stress test) virava um disparo real.
export async function GET(request: Request) {
  const rejection = authorize(request);
  if (rejection) return rejection;
  const { error } = await supabaseAdmin().from("campaigns").select("id").limit(1);
  return NextResponse.json(
    { status: error ? "unavailable" : "healthy" },
    { status: error ? 503 : 200 }
  );
}

export async function POST(request: Request) {
  // Auditoria: escritas desta requisição saem como "system" (cron_disparador).
  await registerAuditActor({ actorType: 'system', source: 'cron_disparador' })
  const rejection = authorize(request);
  if (rejection) return rejection;
  // Identifica esta execução como dona do lock (renovação/liberação só
  // funcionam para o mesmo owner).
  const owner = randomUUID();
  let locked = false;
  // Vira true se a renovação do lock falhar: outro tick pode ter assumido,
  // então paramos de iniciar trabalho novo o quanto antes.
  let lostLease = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Orçamento de tempo do tick. Nenhum trabalho novo começa nos últimos 5s,
  // para a requisição terminar antes do timeout do agendador/proxy.
  const deadline = Date.now() + 40_000;
  try {
    const db = supabaseAdmin();
    // Só um tick por vez em todo o cluster. TTL de 600s cobre crash do
    // processo: o lock expira sozinho e o próximo tick consegue entrar.
    const { data: acquired, error: lockError } = await db.rpc('try_acquire_cron_lock', {
      p_name: 'disparador_cron', p_owner_id: owner, p_ttl_seconds: 600,
    });
    if (lockError) throw lockError;
    if (!acquired) return NextResponse.json({ status: 'already_running' });
    locked = true;
    // Heartbeat do lease. Este setInterval vive só durante a requisição
    // (é limpo no finally) — não é worker em memória, então é compatível
    // com o Passenger.
    heartbeat = setInterval(() => {
      void (async () => {
        try {
          const { data, error } = await db.rpc('renew_cron_lock', { p_name: 'disparador_cron', p_owner: owner });
          if (error || !data) lostLease = true;
        } catch { lostLease = true; }
      })();
    }, 20_000);
    // Reaplica recibos de status (delivered/read/failed) que chegaram antes
    // da confirmação local do envio e entrega um callback pendente. Vem
    // primeiro para não ficar sempre sem tempo quando a fila está cheia.
    const { error: receiptsError } = await db.rpc('reconcile_dispatch_receipts', { p_limit: 100 });
    if (receiptsError) throw receiptsError;
    await drainCallbackOutbox(1);
    // Preflight de deploy: se a coluna next_batch_at (migration 118) não
    // existir, o código novo subiu sem as migrations. Para aqui, antes de
    // qualquer preparação de campanha ou envio externo.
    const { error: readinessError } = await db.from("campaigns").select("next_batch_at").limit(1);
    if (readinessError)
      return NextResponse.json({ error: "Dispatch safety migration required" }, { status: 503 });
    // 0) Campanha presa em 'preparando' (o processo caiu no meio do
    //    startCampaign — o finally não roda num crash): depois de 30 min
    //    volta para 'rascunho' para poder ser iniciada de novo. Os itens
    //    parciais não são consumidos (campanha fora de execução) e o
    //    próximo start limpa a fila antes de publicar.
    const stuckBefore = new Date(Date.now() - 30 * 60_000).toISOString();
    const { error: stuckError } = await db
      .from("campaigns")
      .update({ status: "rascunho", updated_at: new Date().toISOString() })
      .eq("status", "preparando")
      .lt("updated_at", stuckBefore);
    if (stuckError) console.error("[Cron] Falha ao liberar campanhas presas em preparação:", stuckError.message);

    const { data: scheduled, error: scheduledError } = await db
      .from("campaigns")
      .select("id, account_id")
      .eq("status", "agendado")
      .lte("agendamento", new Date().toISOString()).limit(20);
    if (scheduledError) throw scheduledError;
    // 1) Campanhas agendadas cujo horário chegou: monta a fila
    //    (startCampaign deixa a campanha em 'preparando' até terminar).
    for (const campaign of scheduled ?? []) {
      if (lostLease || Date.now() > deadline - 5_000) break;
      if (!campaign.account_id) continue;
      const result = await startCampaign(campaign.id, campaign.account_id);
      if (!result.ok)
        console.error("[Cron] Falha ao preparar campanha:", campaign.id, result.error);
    }
    // 2) Devolve para 'agendado' apenas erros transitórios já classificados
    //    (nunca itens 'enviando' — esses podem ter sido aceitos pelo provedor).
    const { error: retryError } = await db.rpc("retry_transient_queue_errors");
    if (retryError) throw retryError;
    // 3) Campanhas em execução, mais "atrasadas" primeiro (fairness entre
    //    campanhas quando o tick não dá conta de todas).
    const { data: active, error: activeError } = await db
      .from("campaigns")
      .select(
        "id, account_id, status, janela_inicio, janela_fim, batch_size, batch_pause_seconds, limite_por_hora"
      )
      .eq("status", "em_execucao").order('next_batch_at', { ascending: true, nullsFirst: true });
    if (activeError) throw activeError;
    const results: Array<{
      campaign_id: string;
      sent: number;
      pending_confirmation: number;
    }> = [];
    for (const campaign of (active ?? []) as Campaign[]) {
      if (lostLease || Date.now() > deadline - 5_000) break;
      if (!checkWithinWindow(campaign.janela_inicio ?? "", campaign.janela_fim ?? "")) continue;
      // Reserva o próximo lote da campanha no banco: grava next_batch_at =
      // agora + batch_pause_seconds. Se outro tick já reservou dentro da
      // pausa, retorna false e a campanha é pulada — ticks extras não
      // furam o intervalo anti-spam.
      const { data: reserved, error: reservationError } = await db.rpc("reserve_campaign_tick", {
        p_campaign_id: campaign.id,
      });
      if (reservationError) throw reservationError;
      if (!reserved) continue;
      // Logical batch size is separate from simultaneous requests. The database
      // also caps in-flight work shared across campaigns/instances per channel.
      const batchSize = Math.min(100, Math.max(1, campaign.batch_size ?? 1));
      const { data: items, error: queryError } = await db
        .from("disp_message_queue")
        .select("*, contacts(name, phone, company)")
        .eq("campaign_id", campaign.id)
        .eq("status", "agendado")
        .lte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(batchSize);
      if (queryError) throw queryError;
      if (!items?.length) {
        // Fila vazia: tenta encerrar a campanha. A RPC usa o mesmo lock de
        // campanha dos claims e só encerra se não houver item agendado,
        // enviando (incl. resultado desconhecido), pausado ou com retry
        // pendente. Ao encerrar, já enfileira o callback na outbox.
        const { data: completed, error: completionError } = await db.rpc(
          "complete_dispatch_campaign",
          { p_campaign_id: campaign.id }
        );
        if (completionError) throw completionError;
        if (completed) {
          const { error: recalcError } = await db.rpc("recalculate_campaign_metrics", {
            p_campaign_id: campaign.id,
          });
          if (recalcError)
            console.error("[Cron] Falha ao recalcular métricas:", recalcError.message);
        }
        continue;
      }
      const result = {
        campaign_id: campaign.id,
        sent: 0,
        pending_confirmation: 0,
      };
      // Até 4 envios simultâneos por processo. O SELECT acima não reserva
      // nada: cada item ainda passa pelo claim atômico dentro de
      // processQueueItem (claim_dispatch_item), que pode recusá-lo.
      await processWithConcurrency(items as QueueItem[], 4, async (item) => {
        if (lostLease || Date.now() > deadline - 5_000) return;
        try {
          const outcome = await processQueueItem(item, campaign);
          if (outcome.outcome === "sent") result.sent++;
          if (outcome.outcome === "pending_confirmation") result.pending_confirmation++;
        } catch (error) {
          // Exceção depois da chamada ao provedor NÃO devolve o item à fila:
          // ele fica 'enviando' para reconciliação, evitando reenvio cego.
          console.error("[Cron] Item requer investigação:", item.id, error);
        }
      });
      results.push(result);
    }
    // Sobrou tempo? Entrega mais callbacks (inclusive de campanhas
    // encerradas neste tick).
    if (!lostLease && Date.now() < deadline - 10_000) await drainCallbackOutbox();
    return NextResponse.json({
      status: results.length ? "processed" : "idle",
      results,
    });
  } catch (error) {
    console.error("[Cron] Falha operacional:", error);
    return NextResponse.json({ error: "Dispatch processing unavailable" }, { status: 503 });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Libera o lock explicitamente para o próximo tick não esperar o TTL.
    // Falha aqui só é logada: o TTL garante a liberação de qualquer forma.
    if (locked) {
      try {
        const { error } = await supabaseAdmin().rpc('release_cron_lock', { p_name: 'disparador_cron', p_owner_id: owner });
        if (error) console.error('[Cron] Falha ao liberar lock:', error.message);
      } catch (error) { console.error('[Cron] Falha ao liberar lock:', error); }
    }
  }
}
