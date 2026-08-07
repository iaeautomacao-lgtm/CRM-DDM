import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/**
 * A conversation row for the "Histórico de Conversa" timeline. There is
 * no `display_id`/protocol column anywhere in the schema (confirmed
 * during Monitoramento's filter work too) and `assigned_agent_id` has
 * no FK to `profiles` (001_initial_schema.sql:145 — plain UUID, never
 * embedded), so agent/team names are resolved client-side against the
 * already-loaded members/teams lists, same as Monitoramento does.
 * `outcome_tag` IS a real FK (041_conversation_outcome_tags.sql:46) so
 * it's safe to embed directly.
 */
export interface TimelineConversation {
  id: string;
  status: "open" | "pending" | "closed";
  created_at: string;
  updated_at: string;
  contact_id: string;
  assigned_agent_id: string | null;
  team_id: string | null;
  waha_session: string | null;
  outcome_tag_id: string | null;
  outcome_tag: { name: string; color: string } | null;
}

const TIMELINE_SELECT = `
  id, status, created_at, updated_at, contact_id, assigned_agent_id,
  team_id, waha_session, outcome_tag_id,
  outcome_tag:outcome_tag_id ( name, color )
`;

export async function loadContactConversations(
  db: DB,
  {
    accountId,
    contactId,
    wahaSession,
    limit,
  }: {
    accountId: string;
    contactId: string;
    /** null/undefined = "Todos". */
    wahaSession?: string | null;
    limit: number;
  },
): Promise<TimelineConversation[]> {
  let query = db
    .from("conversations")
    .select(TIMELINE_SELECT)
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (wahaSession) {
    query = query.eq("waha_session", wahaSession);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as TimelineConversation[];
}

export interface TimelineMessage {
  id: string;
  sender_type: "customer" | "agent" | "bot";
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  created_at: string;
}

// One more than the display cap — lets the caller detect "there's more
// than 100" without a second COUNT query.
const MESSAGE_FETCH_LIMIT = 101;

export async function loadConversationMessages(
  db: DB,
  conversationId: string,
): Promise<{ messages: TimelineMessage[]; hasMore: boolean }> {
  const { data, error } = await db
    .from("messages")
    .select("id, sender_type, content_type, content_text, media_url, created_at")
    .eq("conversation_id", conversationId)
    .neq("content_type", "template")
    .or("content_text.not.is.null,media_url.not.is.null")
    .order("created_at", { ascending: true })
    .limit(MESSAGE_FETCH_LIMIT);

  if (error) throw error;
  const rows = (data ?? []) as TimelineMessage[];
  const hasMore = rows.length > 100;
  return { messages: hasMore ? rows.slice(0, 100) : rows, hasMore };
}
