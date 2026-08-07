import type { AccountMember } from "@/types";
import type { MonitorConversation } from "./queries";

/**
 * Groups the board's already-loaded live conversations by routing
 * team — reuses the same Map the "Fases" view subscribes to instead
 * of a second fetch or a second realtime channel, same pattern as
 * groupConversationsByAgent in agents.ts. Conversations with no
 * team_id (everything, until phase 3b's automation starts setting it)
 * don't belong to any team column.
 */
export function groupConversationsByTeam(
  conversations: Iterable<MonitorConversation>,
): Map<string, MonitorConversation[]> {
  const byTeam = new Map<string, MonitorConversation[]>();
  for (const conv of conversations) {
    if (!conv.team_id) continue;
    const list = byTeam.get(conv.team_id);
    if (list) list.push(conv);
    else byTeam.set(conv.team_id, [conv]);
  }
  for (const list of byTeam.values()) {
    list.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }
  return byTeam;
}

/**
 * Groups the account's roster (already fetched once for the "Agentes"
 * tab — reused here, no second fetch) by team_id. Agents with no team
 * don't appear in any team column's agent section.
 */
export function groupMembersByTeam(
  members: Iterable<AccountMember>,
): Map<string, AccountMember[]> {
  const byTeam = new Map<string, AccountMember[]>();
  for (const m of members) {
    if (!m.team_id) continue;
    const list = byTeam.get(m.team_id);
    if (list) list.push(m);
    else byTeam.set(m.team_id, [m]);
  }
  for (const list of byTeam.values()) {
    list.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  }
  return byTeam;
}
