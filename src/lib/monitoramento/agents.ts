import type { AccountMember } from "@/types";
import type { PresenceStatus } from "@/lib/presence";
import type { MonitorConversation } from "./queries";

const PRESENCE_RANK: Record<PresenceStatus, number> = {
  online: 0,
  away: 1,
  offline: 2,
};

/** Online first, then away, then offline; ties broken by name. */
export function sortAgentsByPresence(
  agents: AccountMember[],
  getPresence: (userId: string) => PresenceStatus,
): AccountMember[] {
  return [...agents].sort((a, b) => {
    const rankDiff = PRESENCE_RANK[getPresence(a.user_id)] - PRESENCE_RANK[getPresence(b.user_id)];
    if (rankDiff !== 0) return rankDiff;
    return (a.full_name || "").localeCompare(b.full_name || "");
  });
}

/**
 * Groups the board's already-loaded live conversations by assigned
 * agent — reuses the same Map the "Fases" view subscribes to instead of
 * a second fetch or a second realtime channel. Unassigned conversations
 * (bot-handled or awaiting handoff) don't belong to any agent column.
 */
export function groupConversationsByAgent(
  conversations: Iterable<MonitorConversation>,
): Map<string, MonitorConversation[]> {
  const byAgent = new Map<string, MonitorConversation[]>();
  for (const conv of conversations) {
    if (!conv.assigned_agent_id) continue;
    const list = byAgent.get(conv.assigned_agent_id);
    if (list) list.push(conv);
    else byAgent.set(conv.assigned_agent_id, [conv]);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }
  return byAgent;
}
