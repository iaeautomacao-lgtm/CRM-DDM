import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { selectAgentForTeam } from "@/lib/flows/engine";

export async function POST(request: Request) {
  // Auth: reutiliza AUTOMATION_CRON_SECRET (mesmo padrão de
  // /api/flows/cron e /api/automations/cron)
  const secret = process.env.AUTOMATION_CRON_SECRET ?? "";
  const supplied = request.headers.get("x-cron-secret") ?? "";
  if (
    !secret ||
    supplied.length !== secret.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();

  // Busca conversas pending sem agente há pelo menos 5 minutos
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: conversations, error } = await db
    .from("conversations")
    .select("id, team_id, account_id")
    .eq("status", "pending")
    .is("assigned_agent_id", null)
    .not("team_id", "is", null)
    .lte("updated_at", cutoff);

  if (error) {
    console.error("[RetryAssignment] Query error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!conversations || conversations.length === 0) {
    return NextResponse.json({ retried: 0, assigned: 0 });
  }

  let assigned = 0;

  for (const conv of conversations) {
    try {
      if (!conv.team_id || !conv.account_id) continue;

      const agentId = await selectAgentForTeam(
        db,
        conv.team_id,
        conv.account_id
      );

      if (!agentId) continue; // ainda ninguém disponível

      await db
        .from("conversations")
        .update({
          assigned_agent_id: agentId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conv.id)
        .is("assigned_agent_id", null); // guard: só atualiza se ainda null

      assigned++;
      console.log(
        `[RetryAssignment] Conversa ${conv.id} atribuída ao agente ${agentId}`
      );
    } catch (err: any) {
      console.error(
        `[RetryAssignment] Erro na conversa ${conv.id}:`,
        err.message
      );
    }
  }

  return NextResponse.json({
    retried: conversations.length,
    assigned,
  });
}
