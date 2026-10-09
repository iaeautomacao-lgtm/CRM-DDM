import type { SupabaseClient } from "@supabase/supabase-js";
import { periodStartIso, type HistoryPeriod } from "./format";

type DB = SupabaseClient;

export const HISTORY_PAGE_SIZE = 25;

export interface ClosedConversation {
  id: string;
  created_at: string;
  closed_at: string | null;
  updated_at: string;
  contact_id: string;
  assigned_agent_id: string | null;
  team_id: string | null;
  waha_session: string | null;
  channel_type: "whatsapp" | "webchat" | null;
  outcome_tag: { name: string; color: string } | null;
  contact: { name: string | null; phone: string | null } | null;
}

const SELECT = `
  id, created_at, closed_at, updated_at, contact_id, assigned_agent_id, team_id,
  waha_session, channel_type,
  outcome_tag:outcome_tag_id ( name, color ),
  contact:contacts!contact_id ( name, phone )
`;

/**
 * Conversas encerradas da conta, mais recentes primeiro, paginadas com
 * `.range()`. `closed_at` (migration 130) ordena; conversas antigas sem a
 * data caem para o fim. A busca por nome/telefone resolve primeiro os
 * contatos (até 50) e filtra por `contact_id`.
 */
export async function loadClosedConversations(
  db: DB,
  {
    accountId,
    period,
    search,
    page,
  }: { accountId: string; period: HistoryPeriod; search: string; page: number },
): Promise<{ rows: ClosedConversation[]; hasMore: boolean }> {
  let contactIds: string[] | null = null;
  const term = search.trim().replace(/[%,"]/g, "");
  if (term.length >= 2) {
    const { data, error } = await db
      .from("contacts")
      .select("id")
      .eq("account_id", accountId)
      .or(`name.ilike."%${term}%",phone.ilike."%${term}%"`)
      .limit(50);
    if (error) throw error;
    contactIds = (data ?? []).map((c: { id: string }) => c.id);
    if (contactIds.length === 0) return { rows: [], hasMore: false };
  }

  const from = page * HISTORY_PAGE_SIZE;
  let query = db
    .from("conversations")
    .select(SELECT)
    .eq("account_id", accountId)
    .eq("status", "closed")
    .order("closed_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    // Uma a mais que a página: acusa "tem mais" sem um COUNT.
    .range(from, from + HISTORY_PAGE_SIZE);

  const start = periodStartIso(period);
  if (start) query = query.gte("closed_at", start);
  if (contactIds) query = query.in("contact_id", contactIds);

  const { data, error } = await query;
  if (error) throw error;
  const all = (data ?? []) as unknown as ClosedConversation[];
  return { rows: all.slice(0, HISTORY_PAGE_SIZE), hasMore: all.length > HISTORY_PAGE_SIZE };
}
