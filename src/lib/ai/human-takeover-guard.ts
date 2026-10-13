/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeLog } from "@/lib/logger";

export class AiHumanTakeoverError extends Error {
  constructor(public readonly reason: string) {
    super("AI response cancelled: " + reason);
    this.name = "AiHumanTakeoverError";
  }
}

/** Fail closed when database state cannot establish AI ownership. */
export async function assertAiMayRespond(db: SupabaseClient<any, any, any>, accountId: string, conversationId: string): Promise<void> {
  const { data: conv, error } = await db.from("conversations")
    .select("assigned_agent_id, status, contact_id")
    .eq("id", conversationId).eq("account_id", accountId).maybeSingle();
  let reason: string | null = error || !conv ? "conversation_unavailable"
    : conv.assigned_agent_id ? "assigned_to_human"
    : conv.status === "pending" || conv.status === "closed" ? "human_queue_or_closed" : null;
  if (!reason && conv?.contact_id) {
    const { data: runs, error: runError } = await db.from("flow_runs")
      .select("id").eq("account_id", accountId).eq("contact_id", conv.contact_id)
      .eq("conversation_id", conversationId).eq("status", "paused_by_agent").limit(1);
    if (runError) reason = "flow_state_unavailable";
    else if (runs?.length) reason = "flow_paused_by_human";
  }
  if (reason) {
    void writeLog({ account_id: accountId, level: "info", source: "ai_agent",
      event: "ai_reply_blocked_human_takeover", message: "Resposta da IA bloqueada por atendimento humano",
      payload: { conversation_id: conversationId, reason } });
    throw new AiHumanTakeoverError(reason);
  }
}
