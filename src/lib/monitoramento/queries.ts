import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact, ConversationStatus } from "@/types";

type DB = SupabaseClient;

export interface MonitorConversation {
  id: string;
  status: ConversationStatus;
  assigned_agent_id: string | null;
  /** Routing team (migration 049). Null until phase 3b's automation
   *  action starts setting it — every conversation is unassigned in
   *  this phase. */
  team_id: string | null;
  /** WAHA session name (migration 039) — the "channel" a conversation
   *  arrived on. Only ever set for WAHA-provider lines; Meta-provider
   *  conversations have no channel column at all today (confirmed:
   *  the Meta webhook's conversation INSERT never sets this), so this
   *  is null for them — not "unknown", genuinely not tracked. */
  waha_session: string | null;
  updated_at: string;
  contact_id: string;
  contact: Pick<Contact, "id" | "name" | "phone" | "avatar_url"> | null;
}

const MONITOR_SELECT =
  "id, status, assigned_agent_id, team_id, waha_session, updated_at, contact_id, contact:contacts(id, name, phone, avatar_url)";

// Safety cap on the initial catch-up fetch — there's no dedicated
// count/board RPC yet (see loadMetrics in dashboard/queries.ts for the
// same trade-off), so this is a plain `SELECT ... LIMIT`, newest first.
// TODO(monitoramento): once an account routinely has more open+pending
// conversations than this, move to a paginated/virtualized fetch (or a
// dedicated RPC) instead of raising the number.
const INITIAL_FETCH_LIMIT = 500;

/**
 * All open/pending conversations for an account, newest-updated first,
 * with just enough contact info to render a monitoring card. Closed
 * conversations never appear here — this board only tracks the 3 live
 * phases (Navegando / Em espera / Em atendimento).
 */
export async function loadActiveConversations(
  db: DB,
  accountId: string,
): Promise<MonitorConversation[]> {
  const { data, error } = await db
    .from("conversations")
    .select(MONITOR_SELECT)
    .eq("account_id", accountId)
    .in("status", ["open", "pending"])
    .order("updated_at", { ascending: false })
    .limit(INITIAL_FETCH_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as MonitorConversation[];
}

/**
 * Re-fetches a single conversation with its `contact` joined. Realtime
 * `postgres_changes` payloads never carry joined relations, so this is
 * how a brand-new or not-yet-known conversation gets its contact info
 * — mirrors the Inbox's `hydrateConversation` pattern.
 */
export async function loadConversationById(
  db: DB,
  id: string,
): Promise<MonitorConversation | null> {
  const { data, error } = await db
    .from("conversations")
    .select(MONITOR_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as MonitorConversation;
}
