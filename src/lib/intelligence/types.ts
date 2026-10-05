// Linhas que os módulos de cálculo (compute/*) recebem. Só as colunas
// usadas — data.ts seleciona exatamente estas.

export type ConversationStatus = "open" | "pending" | "closed";

export interface ConversationRow {
  id: string;
  status: ConversationStatus;
  channel_type: string | null;
  team_id: string | null;
  client_id: string | null;
  assigned_agent_id: string | null;
  created_at: string;
  first_response_at: string | null;
  closed_at: string | null;
}

/** flow_runs.status (CHECK das migrations 010 + 058). */
export type FlowRunStatus =
  | "active"
  | "completed"
  | "handed_off"
  | "timed_out"
  | "paused_by_agent"
  | "failed"
  | "error"
  | "transferred"
  | "delayed";

export interface FlowRunRow {
  id: string;
  flow_id: string;
  conversation_id: string | null;
  status: FlowRunStatus;
  current_node_key: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

/** flow_run_events (010 + 061 + 067). `status` só vem nos eventos de logRunEvent. */
export interface FlowEventRow {
  id: string;
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  node_type: string | null;
  status: "success" | "error" | "skipped" | null;
  duration_ms: number | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/** Período resolvido: [from, to) em ISO UTC, calendário de Brasília. */
export interface Period {
  from: string;
  to: string;
  label: string;
  days: number;
}
