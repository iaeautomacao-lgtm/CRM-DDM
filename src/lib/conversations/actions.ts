import type { SupabaseClient } from "@supabase/supabase-js";
import type { Tag } from "@/types";

type DB = SupabaseClient;

/**
 * Assigns (or clears, agentId=null) a conversation's agent — same
 * direct client UPDATE message-thread.tsx's handleAssignChange uses.
 * `conversations_update` RLS (017_account_sharing.sql:416) is a
 * whole-row policy requiring only agent+, no column restriction, so
 * this needs no RPC (unlike profiles.team_id's set_member_team, which
 * exists specifically because profiles_update is auth.uid()-only).
 *
 * Also fires the same "takeover" WhatsApp message to the customer
 * that message-thread.tsx sends on assignment, so the customer-facing
 * behavior is identical regardless of where the assignment happened
 * (Inbox or Monitoramento) — extracted here so both call sites share
 * one implementation instead of drifting.
 */
export async function assignConversationAgent(
  db: DB,
  conversationId: string,
  agentId: string | null,
  agentFullName?: string | null,
): Promise<{ error: string | null }> {
  const { error } = await db
    .from("conversations")
    .update({ assigned_agent_id: agentId })
    .eq("id", conversationId);

  if (error) return { error: error.message };

  if (agentId) {
    const agentName = agentFullName || "Atendente";
    const takeoverText = `Olá, aqui é o atendente ${agentName} e agora vou dar continuidade ao seu atendimento.`;
    try {
      await apiFetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message_type: "text",
          content_text: takeoverText,
        }),
      });
    } catch (err) {
      console.error("[assignConversationAgent] takeover message failed:", err);
    }
  }

  return { error: null };
}

/**
 * Moves (or clears, teamId=null) a conversation's team. Same RLS shape
 * as assignConversationAgent — a plain client UPDATE, no RPC.
 */
export async function assignConversationTeam(
  db: DB,
  conversationId: string,
  teamId: string | null,
): Promise<{ error: string | null }> {
  const { error } = await db
    .from("conversations")
    .update({ team_id: teamId })
    .eq("id", conversationId);
  return { error: error ? error.message : null };
}

/**
 * Closes a conversation with a required outcome tag — mirrors
 * message-thread.tsx's handleStatusChange("closed", tag). Callers
 * must only invoke this from an OutcomeTagPicker's onSelect (never on
 * a bare "close" action) so a conversation can't be closed without a
 * tabulação tag, matching the Inbox's existing guarantee exactly.
 */
export async function closeConversationWithOutcomeTag(
  db: DB,
  conversationId: string,
  tag: Tag,
): Promise<{ error: string | null }> {
  const { error } = await db
    .from("conversations")
    .update({ status: "closed", outcome_tag_id: tag.id })
    .eq("id", conversationId);
  if (error) return { error: error.message };

  await endActiveFlowRun(conversationId);
  return { error: null };
}

/**
 * Ends the conversation's active flow run, if any — a human closing/
 * tabulating a conversation is the strongest "stop the automated flow"
 * signal there is, but the flow engine's admin-only queries aren't
 * reachable from the browser client these actions run under, hence the
 * API route. Best-effort: a failure here shouldn't block the close
 * itself, which already committed via the direct `conversations` update
 * above.
 */
async function endActiveFlowRun(conversationId: string): Promise<void> {
  try {
    await apiFetch("/api/flows/end-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        reason: "conversation_closed",
      }),
    });
  } catch (err) {
    console.error("[endActiveFlowRun] failed:", err);
  }
}
import { apiFetch } from "@/lib/api-fetch";