import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { getDisparadorScope } from "@/lib/disparador/scope";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { db: { schema: "wacrm" } }
);

export async function DELETE(
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

    // wacrm.campaigns has no account_id column yet (migration 040 not
    // applied), so scope ownership through created_by -> profiles.account_id
    // — same as the campanhas/disparador list reads (see getDisparadorScope).
    const { userIds } = await getDisparadorScope(supabase);

    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaigns")
      .select("id, created_by, status")
      .eq("id", campaignId)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    if (!campaign.created_by || !userIds.includes(campaign.created_by)) {
      return NextResponse.json(
        { error: "Você não tem permissão para deletar esta campanha." },
        { status: 403 }
      );
    }

    // disp_message_queue.campaign_id is ON DELETE CASCADE, so deleting a
    // running campaign silently wipes its in-flight queue mid-send.
    // Re-checked here since the client-side check can be bypassed by
    // calling this route directly.
    if (campaign.status === "em_execucao") {
      return NextResponse.json(
        { error: "Não é possível deletar uma campanha em execução. Pause ou encerre a campanha primeiro." },
        { status: 409 }
      );
    }

    const { error: deleteError } = await supabaseAdmin
      .from("campaigns")
      .delete()
      .eq("id", campaignId);

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[Campaign Delete] Failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
