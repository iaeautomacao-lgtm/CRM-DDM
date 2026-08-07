import type { MonitorConversation } from "./queries";

/**
 * Shared filter state for the Monitoramento board — one set of
 * criteria applied before grouping into whichever tab is active
 * (Fases/Agentes/Equipes), not duplicated per tab. Multi-select on
 * every list criterion (empty array = no restriction on that field);
 * Contato is free text.
 */
export interface MonitorFilters {
  agentIds: string[];
  teamIds: string[];
  /** WAHA session names (see MonitorConversation.waha_session) — not
   *  IDs, since that's the only identifier a WAHA line has. */
  channels: string[];
  /** Matched against the contact's name OR phone, case-insensitive. */
  contactQuery: string;
  tagIds: string[];
}

export const EMPTY_FILTERS: MonitorFilters = {
  agentIds: [],
  teamIds: [],
  channels: [],
  contactQuery: "",
  tagIds: [],
};

export function hasActiveFilters(filters: MonitorFilters): boolean {
  return (
    filters.agentIds.length > 0 ||
    filters.teamIds.length > 0 ||
    filters.channels.length > 0 ||
    filters.contactQuery.trim() !== "" ||
    filters.tagIds.length > 0
  );
}

/**
 * Filters the board's already-loaded live conversations against the
 * applied criteria. Every criterion is AND-ed together; within a
 * multi-select criterion, any one match is enough (OR).
 *
 * `contactTagsByContact` is a contact_id -> set-of-tag-id lookup,
 * built once from `contact_tags` (see monitoramento/page.tsx) — a
 * conversation's contact tags aren't part of MonitorConversation
 * itself, so this is passed in rather than read off `conv`.
 */
export function filterConversations(
  conversations: Iterable<MonitorConversation>,
  filters: MonitorFilters,
  contactTagsByContact: Map<string, Set<string>>,
): MonitorConversation[] {
  const query = filters.contactQuery.trim().toLowerCase();
  const out: MonitorConversation[] = [];

  for (const conv of conversations) {
    if (
      filters.agentIds.length > 0 &&
      (!conv.assigned_agent_id || !filters.agentIds.includes(conv.assigned_agent_id))
    ) {
      continue;
    }

    if (filters.teamIds.length > 0 && (!conv.team_id || !filters.teamIds.includes(conv.team_id))) {
      continue;
    }

    if (
      filters.channels.length > 0 &&
      (!conv.waha_session || !filters.channels.includes(conv.waha_session))
    ) {
      continue;
    }

    if (query) {
      const name = conv.contact?.name?.toLowerCase() ?? "";
      const phone = conv.contact?.phone?.toLowerCase() ?? "";
      if (!name.includes(query) && !phone.includes(query)) continue;
    }

    if (filters.tagIds.length > 0) {
      const tagSet = contactTagsByContact.get(conv.contact_id);
      if (!tagSet || !filters.tagIds.some((id) => tagSet.has(id))) continue;
    }

    out.push(conv);
  }

  return out;
}
