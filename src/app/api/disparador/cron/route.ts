import { NextResponse } from "next/server";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import {
  processQueueItem,
  checkWithinWindow,
  sendCampaignCallback,
  type QueueItem,
  type Campaign,
} from "@/lib/disparador/processQueue";
import { processWithConcurrency } from "@/lib/disparador/concurrency";
import { startCampaign } from "@/lib/disparador/startCampaign";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

function authorize(request: Request): NextResponse | null {
  if (!process.env.CRON_SECRET)
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// Diagnostics must not start campaigns, drain queues, retry or emit callbacks.
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
  const rejection = authorize(request);
  if (rejection) return rejection;
  try {
    const db = supabaseAdmin();
    // Deployment preflight before any campaign preparation or external effects.
    const { error: readinessError } = await db.from("campaigns").select("next_batch_at").limit(1);
    if (readinessError)
      return NextResponse.json({ error: "Dispatch safety migration required" }, { status: 503 });
    const { data: scheduled, error: scheduledError } = await db
      .from("campaigns")
      .select("id, account_id")
      .eq("status", "agendado")
      .lte("agendamento", new Date().toISOString());
    if (scheduledError) throw scheduledError;
    for (const campaign of scheduled ?? []) {
      if (!campaign.account_id) continue;
      const result = await startCampaign(campaign.id, campaign.account_id);
      if (!result.ok)
        console.error("[Cron] Falha ao preparar campanha:", campaign.id, result.error);
    }
    const { error: retryError } = await db.rpc("retry_transient_queue_errors");
    if (retryError) throw retryError;
    const { data: active, error: activeError } = await db
      .from("campaigns")
      .select(
        "id, status, janela_inicio, janela_fim, batch_size, batch_pause_seconds, limite_por_hora"
      )
      .eq("status", "em_execucao");
    if (activeError) throw activeError;
    const results: Array<{
      campaign_id: string;
      sent: number;
      pending_confirmation: number;
    }> = [];
    for (const campaign of (active ?? []) as Campaign[]) {
      if (
        campaign.janela_inicio &&
        campaign.janela_fim &&
        !checkWithinWindow(campaign.janela_inicio, campaign.janela_fim)
      )
        continue;
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
        // Counts in-flight/unknown results and takes the same lock as claims.
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
          await sendCampaignCallback(campaign.id);
        }
        continue;
      }
      const result = {
        campaign_id: campaign.id,
        sent: 0,
        pending_confirmation: 0,
      };
      await processWithConcurrency(items as QueueItem[], 4, async (item) => {
        try {
          const outcome = await processQueueItem(item, campaign);
          if (outcome.outcome === "sent") result.sent++;
          if (outcome.outcome === "pending_confirmation") result.pending_confirmation++;
        } catch (error) {
          // An exception after a provider call must not reopen the reservation.
          console.error("[Cron] Item requer investigação:", item.id, error);
        }
      });
      results.push(result);
    }
    return NextResponse.json({
      status: results.length ? "processed" : "idle",
      results,
    });
  } catch (error) {
    console.error("[Cron] Falha operacional:", error);
    return NextResponse.json({ error: "Dispatch processing unavailable" }, { status: 503 });
  }
}
