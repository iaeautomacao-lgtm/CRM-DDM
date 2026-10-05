// Carregadores de dados do Intelligence. Service role (supabaseAdmin) —
// RLS NÃO protege aqui, então TODA consulta filtra explicitamente:
//   - conversations: .eq('account_id') e, para supervisor, .in('team_id')
//   - flow_runs: .eq('account_id') e, para supervisor, só as execuções
//     cujas conversas estão nas equipes dele (conversa sem equipe ou
//     execução sem conversa fica fora)
//   - flow_run_events / messages: só por ids já escopados acima
// Paginação com .range() + .order('id') estável; teto de linhas com
// `truncated` para o modelo saber que o número é parcial.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntelligenceScope } from "./scope";
import type { ConversationRow, FlowEventRow, FlowRunRow, Period } from "./types";

export const PAGE_SIZE = 1000;
export const MAX_ROWS = 20_000;
export const MAX_EVENT_ROWS = 50_000;
export const IN_CHUNK = 200;

export interface Loaded<T> {
  rows: T[];
  truncated: boolean;
}

type PageResult = { data: unknown[] | null; error: { message: string } | null };

/**
 * Pagina `build(from, to)` até acabar ou chegar em `cap`. `build` é
 * síncrono e devolve o builder (thenable) — o await é feito aqui.
 */
export async function paginate<T>(
  build: (from: number, to: number) => PromiseLike<PageResult>,
  cap = MAX_ROWS,
  pageSize = PAGE_SIZE,
): Promise<Loaded<T>> {
  const rows: T[] = [];
  for (let from = 0; rows.length < cap; from += pageSize) {
    const size = Math.min(pageSize, cap - rows.length);
    const { data, error } = await build(from, from + size - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < size) return { rows, truncated: false };
  }
  // Chegou no teto: confere se havia mais.
  const { data, error } = await build(cap, cap);
  if (error) throw new Error(error.message);
  return { rows, truncated: (data ?? []).length > 0 };
}

export function chunk<T>(list: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * SELECT em conversations já com o filtro de escopo: sempre a conta e,
 * para supervisor, as equipes dele. Única porta de entrada para ler
 * conversas no Intelligence.
 */
export function conversationsQuery(
  db: SupabaseClient,
  scope: IntelligenceScope,
  columns: string,
  opts: { count?: "exact" } = {},
) {
  const q = db.from("conversations").select(columns, opts).eq("account_id", scope.accountId);
  return scope.teamIds === null ? q : q.in("team_id", scope.teamIds);
}

// ------------------------------------------------------------
// Conversas
// ------------------------------------------------------------

export const CONVERSATION_COLUMNS =
  "id, status, channel_type, team_id, client_id, assigned_agent_id, created_at, first_response_at, closed_at";

export interface ConversationFilters {
  status?: "open" | "pending" | "closed";
  channel_type?: string;
  team_id?: string;
  agent_id?: string;
  client_id?: string;
}

/**
 * Conversas que "tocam" o período: criadas, atendidas (1ª resposta) ou
 * finalizadas nele — mesmo critério de /api/monitoramento/dia.
 */
export async function loadPeriodConversations(
  db: SupabaseClient,
  scope: IntelligenceScope,
  period: Period,
): Promise<Loaded<ConversationRow>> {
  const { from, to } = period;
  const touches = [
    `and(created_at.gte.${from},created_at.lt.${to})`,
    `and(first_response_at.gte.${from},first_response_at.lt.${to})`,
    `and(closed_at.gte.${from},closed_at.lt.${to})`,
  ].join(",");
  return paginate<ConversationRow>((a, b) =>
    conversationsQuery(db, scope, CONVERSATION_COLUMNS)
      .or(touches)
      .order("id")
      .range(a, b),
  );
}

/** Abertas/pendentes agora (para "em aberto agora" por atendente). */
export async function loadOpenNowConversations(
  db: SupabaseClient,
  scope: IntelligenceScope,
): Promise<Loaded<Pick<ConversationRow, "id" | "assigned_agent_id" | "status">>> {
  return paginate((a, b) =>
    conversationsQuery(db, scope, "id, assigned_agent_id, status")
      .in("status", ["open", "pending"])
      .order("id")
      .range(a, b),
  );
}

export interface ConversationMeta {
  client_id: string | null;
  team_id: string | null;
}

/** id → meta, só das conversas que estão no escopo (as demais somem). */
export async function loadConversationMetaByIds(
  db: SupabaseClient,
  scope: IntelligenceScope,
  ids: string[],
): Promise<Map<string, ConversationMeta>> {
  const out = new Map<string, ConversationMeta>();
  for (const part of chunk([...new Set(ids)])) {
    const { data, error } = await conversationsQuery(db, scope, "id, client_id, team_id")
      .in("id", part)
      .order("id")
      .range(0, part.length - 1);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as unknown as Array<{ id: string } & ConversationMeta>) {
      out.set(r.id, { client_id: r.client_id, team_id: r.team_id });
    }
  }
  return out;
}

// ------------------------------------------------------------
// Execuções de fluxo e eventos
// ------------------------------------------------------------

export const RUN_COLUMNS = "id, flow_id, conversation_id, status, current_node_key, started_at, ended_at, end_reason";

export interface ScopedRuns extends Loaded<FlowRunRow> {
  /** Meta das conversas das execuções (quando carregada). */
  conversationMeta: Map<string, ConversationMeta> | null;
}

/** Execuções iniciadas no período, no escopo. */
export async function loadFlowRuns(
  db: SupabaseClient,
  scope: IntelligenceScope,
  period: Period,
  opts: { withConversationMeta?: boolean; flowId?: string } = {},
): Promise<ScopedRuns> {
  if (scope.teamIds !== null && scope.teamIds.length === 0) {
    return { rows: [], truncated: false, conversationMeta: new Map() };
  }
  const teamIds = scope.teamIds;
  const loaded = await paginate<FlowRunRow>((a, b) => {
    let q = db
      .from("flow_runs")
      .select(teamIds === null ? RUN_COLUMNS : `${RUN_COLUMNS}, conversations!conversation_id!inner(team_id)`)
      .eq("account_id", scope.accountId)
      .gte("started_at", period.from)
      .lt("started_at", period.to);
    // Supervisor: o teto de linhas vale para as equipes dele, não para a
    // conta toda.
    if (teamIds !== null) q = q.in("conversations.team_id", teamIds);
    if (opts.flowId) q = q.eq("flow_id", opts.flowId);
    return q.order("id").range(a, b);
  });
  if (teamIds !== null) {
    for (const r of loaded.rows as Array<FlowRunRow & { conversations?: unknown }>) delete r.conversations;
  }

  const needMeta = scope.teamIds !== null || opts.withConversationMeta === true;
  if (!needMeta) return { ...loaded, conversationMeta: null };

  const convIds = loaded.rows.map((r) => r.conversation_id).filter((id): id is string => !!id);
  const meta = await loadConversationMetaByIds(db, scope, convIds);
  const rows =
    scope.teamIds === null
      ? loaded.rows
      : loaded.rows.filter((r) => r.conversation_id !== null && meta.has(r.conversation_id));
  return { rows, truncated: loaded.truncated, conversationMeta: meta };
}

/** Só os tipos que as métricas usam (message_sent/node_completed/... ficam fora). */
export const RELEVANT_EVENT_TYPES = [
  "node_entered",
  "handoff",
  "fallback_fired",
  "tool_called",
  "tool_result",
  "error",
  "node_error",
  "run_error",
  "timeout",
  "ai_agent_failed",
] as const;

// Do payload só vêm as chaves usadas (o payload inteiro carrega args,
// variáveis e respostas de API — pesado e com dado de cliente).
const EVENT_COLUMNS =
  "id, flow_run_id, event_type, node_key, node_type, status, duration_ms, created_at, " +
  "p_tool_name:payload->>tool_name, p_reason:payload->>reason, p_node_type:payload->>node_type, p_result:payload->>result";

interface EventSelectRow {
  id: string;
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  node_type: string | null;
  status: FlowEventRow["status"];
  duration_ms: number | null;
  created_at: string;
  p_tool_name: string | null;
  p_reason: string | null;
  p_node_type: string | null;
  p_result: string | null;
}

export function toEventRow(r: EventSelectRow): FlowEventRow {
  const payload: Record<string, unknown> = {};
  if (r.p_tool_name !== null && r.p_tool_name !== undefined) payload.tool_name = r.p_tool_name;
  if (r.p_reason !== null && r.p_reason !== undefined) payload.reason = r.p_reason;
  if (r.p_node_type !== null && r.p_node_type !== undefined) payload.node_type = r.p_node_type;
  if (r.p_result !== null && r.p_result !== undefined) payload.result = r.p_result;
  return {
    id: r.id,
    flow_run_id: r.flow_run_id,
    event_type: r.event_type,
    node_key: r.node_key,
    node_type: r.node_type,
    status: r.status,
    duration_ms: r.duration_ms,
    payload,
    created_at: r.created_at,
  };
}

export async function loadRunEvents(db: SupabaseClient, runIds: string[]): Promise<Loaded<FlowEventRow>> {
  const rows: FlowEventRow[] = [];
  let truncated = false;
  for (const part of chunk([...new Set(runIds)])) {
    const remaining = MAX_EVENT_ROWS - rows.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const page = await paginate<EventSelectRow>(
      (a, b) =>
        db
          .from("flow_run_events")
          .select(EVENT_COLUMNS)
          .in("flow_run_id", part)
          .in("event_type", [...RELEVANT_EVENT_TYPES])
          .order("id")
          .range(a, b),
      remaining,
    );
    rows.push(...page.rows.map(toEventRow));
    if (page.truncated) truncated = true;
  }
  return { rows, truncated };
}

// ------------------------------------------------------------
// Nomes (dimensões)
// ------------------------------------------------------------

async function namesByIds(
  db: SupabaseClient,
  table: string,
  idColumn: string,
  nameColumn: string,
  accountId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk([...new Set(ids.filter(Boolean))])) {
    const { data, error } = await db
      .from(table)
      .select(`${idColumn}, ${nameColumn}`)
      .eq("account_id", accountId)
      .in(idColumn, part)
      .order(idColumn)
      .range(0, part.length - 1);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as unknown as Array<Record<string, string | null>>) {
      const id = r[idColumn];
      if (id) out.set(id, r[nameColumn] ?? id);
    }
  }
  return out;
}

export function loadFlowNames(db: SupabaseClient, scope: IntelligenceScope, ids: string[]) {
  return namesByIds(db, "flows", "id", "name", scope.accountId, ids);
}

export function loadAgentNames(db: SupabaseClient, scope: IntelligenceScope, ids: string[]) {
  return namesByIds(db, "profiles", "user_id", "full_name", scope.accountId, ids);
}

export function loadClientNames(db: SupabaseClient, scope: IntelligenceScope, ids: string[]) {
  return namesByIds(db, "clients", "id", "name", scope.accountId, ids);
}

export function loadTeamNames(db: SupabaseClient, scope: IntelligenceScope, ids: string[]) {
  return namesByIds(db, "teams", "id", "name", scope.accountId, ids);
}
