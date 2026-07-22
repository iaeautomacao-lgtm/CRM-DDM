import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { db: { schema: "wacrm" } }
);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const { id: campaignId } = await params;

    // wacrm.campaigns has no account_id column (only created_by), so
    // ownership is checked per-user rather than per-account for now.
    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaigns")
      .select("id, created_by")
      .eq("id", campaignId)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    if (campaign.created_by !== user.id) {
      return NextResponse.json(
        { error: "Você não tem permissão para executar esta campanha." },
        { status: 403 }
      );
    }

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "stop"; // 'stop' or 'pause'

    if (action === "pause") {
      // 1. Update status to 'pausada' (Paused)
      await supabaseAdmin
        .from("campaigns")
        .update({ status: "pausada" })
        .eq("id", campaignId);

      // 2. Pause scheduled items in the queue (set status to 'pausado')
      await supabaseAdmin
        .from("disp_message_queue")
        .update({ status: "pausado" })
        .eq("campaign_id", campaignId)
        .in("status", ["agendado", "pendente"]);

      return NextResponse.json({ success: true, status: "pausada" });
    } else {
      // 1. Update status to 'encerrada' (Closed)
      await supabaseAdmin
        .from("campaigns")
        .update({ status: "encerrada" })
        .eq("id", campaignId);

      // 2. Cancel scheduled items in the queue (set status to 'cancelado')
      await supabaseAdmin
        .from("disp_message_queue")
        .update({ status: "cancelado" })
        .eq("campaign_id", campaignId)
        .in("status", ["agendado", "pendente", "pausado"]);

      return NextResponse.json({ success: true, status: "encerrada" });
    }
  } catch (err: any) {
    console.error("[Campaign Stop/Pause] Failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
