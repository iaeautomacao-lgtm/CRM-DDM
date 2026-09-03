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
