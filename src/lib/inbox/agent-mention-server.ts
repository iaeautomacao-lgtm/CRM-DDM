import { supabaseAdmin } from "@/lib/flows/admin-client";
import { writeLog } from "@/lib/logger";
import { mentionedAgentAlias } from "./agent-mention";

// Called only after an authenticated provider webhook persisted the inbound
// customer message. No LLM or client-side input decides the destination.
export async function tryMentionAgentHandoff(input: {
  accountId: string;
  conversationId: string;
  text: string | null | undefined;
}): Promise<boolean> {
  const alias = mentionedAgentAlias(input.text);
  if (!alias) return false;
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("route_conversation_to_mentioned_agent", {
    p_account_id: input.accountId,
    p_conversation_id: input.conversationId,
    p_alias: alias,
  });
  if (error) {
    console.error("[agent-mention] failed:", error.message);
    // Fail closed. An eligible mention should not go to an LLM when the
    // routing infrastructure fails, even if this means operator intervention.
    throw error;
  }
  if (!data) return false;
  void writeLog({
    account_id: input.accountId, level: "info", source: "flows",
    event: "agent_mention_handoff",
    message: "Cliente solicitou atendimento por operador",
    payload: { conversation_id: input.conversationId, agent_id: data },
  });
  return true;
}
