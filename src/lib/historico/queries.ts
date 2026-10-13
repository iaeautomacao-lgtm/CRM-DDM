import type { SupabaseClient } from "@supabase/supabase-js";
import { startOfDayIso, endOfDayIso } from "@/lib/relatorios/date-range";
import { periodStartIso, type HistoryPeriod } from "./format";

type DB = SupabaseClient;

export const HISTORY_PAGE_SIZE = 25;

/** Situação da conversa no filtro: encerradas (padrão), em andamento ou todas (antes no relatório Conversas). */
export type HistoryStatus = "closed" | "open" | "all";

/** Período personalizado (datas yyyy-MM-dd, locais); qualquer ponta vazia fica sem limite. */
export interface HistoryRange {
  from: string;
  to: string;
}

export interface ClosedConversation {
  id: string;
  status: string;
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
  id, status, created_at, closed_at, updated_at, contact_id, assigned_agent_id, team_id,
  waha_session, channel_type,
  outcome_tag:outcome_tag_id ( name, color ),
  contact:contacts!contact_id ( name, phone )
`;

/**
 * Conversas da conta, mais recentes primeiro, paginadas com `.range()`.
 * Encerradas (padrão): `closed_at` (migration 130) ordena e filtra o período; conversas antigas sem a data
 * caem para o fim. Em andamento ou todas: ordena e filtra o período por `created_at`. A busca por
 * nome/telefone resolve primeiro os contatos (até 50) e filtra por `contact_id`.
 */
export async function loadClosedConversations(
  db: DB,
  {
    accountId,
    period,
    search,
    page,
    tabulacao = null,
    status = "closed",
    range = null,
  }: {
    accountId: string;
    period: HistoryPeriod;
    search: string;
    page: number;
    tabulacao?: string | null;
    status?: HistoryStatus;
    /** Quando informado, vale no lugar do `period`. */
    range?: HistoryRange | null;
  },
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
  const dateColumn = status === "closed" ? "closed_at" : "created_at";
  let query = db.from("conversations").select(SELECT).eq("account_id", accountId);
  if (status !== "all") query = query.eq("status", status);
  query = query
    .order(dateColumn, { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    // Uma a mais que a página: acusa "tem mais" sem um COUNT.
    .range(from, from + HISTORY_PAGE_SIZE);

  if (range) {
    if (range.from) query = query.gte(dateColumn, startOfDayIso(range.from));
    if (range.to) query = query.lte(dateColumn, endOfDayIso(range.to));
  } else {
    const start = periodStartIso(period);
    if (start) query = query.gte(dateColumn, start);
  }
  if (contactIds) query = query.in("contact_id", contactIds);
  // Filtro por tabulação (tags.id gravada em conversations.outcome_tag_id ao encerrar; índice idx_conversations_outcome_tag, 041).
  if (tabulacao) query = query.eq("outcome_tag_id", tabulacao);

  const { data, error } = await query;
  if (error) throw error;
  const all = (data ?? []) as unknown as ClosedConversation[];
  return { rows: all.slice(0, HISTORY_PAGE_SIZE), hasMore: all.length > HISTORY_PAGE_SIZE };
}
