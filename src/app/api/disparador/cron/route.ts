import { NextResponse } from "next/server";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";
import {
  processQueueItem,
  type QueueItem,
  type Campaign,
} from "@/lib/disparador/processQueue";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

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

    ensureQueueWorkerRunning();

    // Verificar campanhas agendadas que devem ser iniciadas agora
    const nowStr = new Date().toISOString();
    const { data: campanhasAgendadas } = await supabaseAdmin()
      .from("campaigns")
      .select("id")
      .eq("status", "agendado")
      .lte("agendamento", nowStr);

    for (const campanha of campanhasAgendadas ?? []) {
      try {
        // Chama o endpoint de start internamente
        const startUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/disparador/campaigns/${campanha.id}/start`;
        await fetch(startUrl, {
          method: "POST",
          headers: {
            // Usa o mesmo CRON_SECRET para autenticar o start interno
            "x-internal-cron": process.env.CRON_SECRET ?? "",
          },
        });
        console.log(`[Cron] Campanha agendada ${campanha.id} iniciada automaticamente`);
      } catch (err: any) {
        console.error(`[Cron] Erro ao iniciar campanha agendada ${campanha.id}:`, err.message);
      }
    }

    const now = new Date().toISOString();
    const { data: item, error: queryError } = await supabaseAdmin()
      .from("disp_message_queue")
      .select("*, contacts(name, phone, company)")
      .eq("status", "agendado")
      .lte("scheduled_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (queryError) {
      console.error("[Cron] Database error:", queryError);
      return NextResponse.json({ error: queryError.message }, { status: 500 });
    }

    if (!item) {
      return NextResponse.json({ status: "idle", message: "No scheduled messages to send" });
    }

    // ATENÇÃO: race condition com worker.ts — ambos consomem a mesma fila.
    // processQueueItem já se protege contra double-send (claim atômico
    // condicionado a status='agendado', ver processQueue.ts), então dois
    // consumidores pegando o mesmo item não duplicam o envio — mas ainda
    // há dois pollers independentes competindo pela fila sem coordenação.
    // Após confirmar a migration 075 em produção e o worker estável por 7
    // dias, remover este bloco e centralizar o consumo apenas no worker.
    // Mantido agora como safety net para Phusion Passenger.
    console.log(`[Cron] Processing item ${item.id} for campaign ${item.campaign_id}`);

    const { data: campaign } = await supabaseAdmin()
      .from("campaigns")
      .select("id, status, janela_inicio, janela_fim")
      .eq("id", item.campaign_id)
      .single();

    if (!campaign || campaign.status !== "em_execucao") {
      await supabaseAdmin()
        .from("disp_message_queue")
        .update({ status: "cancelado" })
        .eq("id", item.id);
      return NextResponse.json({ status: "skipped", message: "Campaign is not running" });
    }

    const result = await processQueueItem(item as QueueItem, campaign as Campaign);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[Cron] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
