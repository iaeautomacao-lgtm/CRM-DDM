// Tipos e rótulos da tela /regua (PRD 17). Só tipos e funções puras: os componentes 'use client' NÃO importam
// ruler-api.ts nem enqueuer.ts (são server-only). O contrato é o das rotas /api/billing/*.

export type VariableSource =
  | { type: "contact_field"; field: "name" | "phone" | "email" | "company" }
  | { type: "debt_field"; field: "due_date" | "amount" | "external_ref" }
  | { type: "static"; value: string };

export interface Ruler {
  id: string;
  name: string;
  active: boolean;
  dry_run: boolean;
  channel_id: string | null;
  window_start: string;
  window_end: string;
  weekdays: number[];
  daily_cap_per_debtor: number;
  tolerance_days: number;
  pause_on_open_conversation: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
  steps_count?: number;
}

export interface RulerStep {
  id: string;
  ruler_id: string;
  position: number;
  kind: "offset" | "status";
  offset_days: number | null;
  status_trigger: string | null;
  template_id: string | null;
  message_text: string | null;
  variable_map: VariableSource[];
  conditions: Record<string, unknown>;
  active: boolean;
  updated_at: string;
}

export type EnrollmentStatus = "active" | "paused" | "stopped" | "completed";
export type StopReason =
  | "paid"
  | "agreement"
  | "opt_out"
  | "blacklist"
  | "cancelled"
  | "contact_removed"
  | "ruler_disabled"
  | "manual";

export interface EnrollmentRow {
  id: string;
  ruler_id: string;
  status: EnrollmentStatus;
  stop_reason: StopReason | null;
  stopped_at: string | null;
  next_step_at: string | null;
  created_at: string;
  debt: { id: string; due_date: string; amount_cents: number | null; status: string; external_ref: string } | null;
  contact: { id: string; name: string | null } | null;
}

export interface DryRunResult {
  date: string;
  steps: Array<{ step_id: string; position: number; offset_days: number | null; debts: number }>;
  total: number;
}

export interface RulerMetrics {
  ruler_id: string;
  steps: Array<{
    step_id: string;
    position: number;
    offset_days: number | null;
    active: boolean;
    total: number;
    by_status: Record<string, number>;
  }>;
  enrollments: Array<{ status: string; stop_reason: string | null; total: number }>;
}

export type RulerState = "off" | "simulation" | "live";

/** Desligada, em simulação (dry-run: o motor calcula mas não envia) ou ativa de verdade. */
export function rulerState(r: Pick<Ruler, "active" | "dry_run">): RulerState {
  if (!r.active) return "off";
  return r.dry_run ? "simulation" : "live";
}

export const RULER_STATE_LABEL: Record<RulerState, string> = {
  off: "Desligada",
  simulation: "Em simulação",
  live: "Ativa",
};

export const ENROLLMENT_STATUS_LABEL: Record<EnrollmentStatus, string> = {
  active: "Ativa",
  paused: "Pausada",
  stopped: "Parada",
  completed: "Concluída",
};

export const STOP_REASON_LABEL: Record<StopReason, string> = {
  paid: "Pago",
  agreement: "Acordo",
  opt_out: "Pediu para sair",
  blacklist: "Lista de bloqueio",
  cancelled: "Dívida cancelada",
  contact_removed: "Contato removido",
  ruler_disabled: "Régua desligada",
  manual: "Parada manual",
};

export const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

/** "D-3", "D0", "D+2". */
export function formatOffset(days: number): string {
  return days === 0 ? "D0" : days < 0 ? `D${days}` : `D+${days}`;
}

/** "No dia do vencimento", "3 dias antes do vencimento", "1 dia depois do vencimento". */
export function describeOffset(days: number): string {
  if (days === 0) return "No dia do vencimento";
  const n = Math.abs(days);
  return `${n} ${n === 1 ? "dia" : "dias"} ${days < 0 ? "antes" : "depois"} do vencimento`;
}

/** Valor em centavos → "R$ 1.234,56" ("—" sem valor). */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "2026-10-20" → "20/10/2026" (sem passar por Date: não sofre com fuso). */
export function formatCivilDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Maior {{n}} de um texto (0 = nenhum): quantas fontes o variable_map precisa ter. */
export function maxPlaceholder(text: string | null | undefined): number {
  let max = 0;
  for (const m of (text ?? "").matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export const VARIABLE_OPTIONS: ReadonlyArray<{ value: string; label: string; source: VariableSource }> = [
  { value: "contact:name", label: "Nome do contato", source: { type: "contact_field", field: "name" } },
  { value: "contact:phone", label: "Telefone do contato", source: { type: "contact_field", field: "phone" } },
  { value: "contact:email", label: "E-mail do contato", source: { type: "contact_field", field: "email" } },
  { value: "contact:company", label: "Empresa do contato", source: { type: "contact_field", field: "company" } },
  { value: "debt:due_date", label: "Vencimento da dívida", source: { type: "debt_field", field: "due_date" } },
  { value: "debt:amount", label: "Valor da dívida", source: { type: "debt_field", field: "amount" } },
  { value: "debt:external_ref", label: "Referência da dívida", source: { type: "debt_field", field: "external_ref" } },
];

/** Chave do <select> para uma fonte ("static" para texto fixo). */
export function variableKey(src: VariableSource | undefined): string {
  if (!src) return "";
  if (src.type === "static") return "static";
  return `${src.type === "contact_field" ? "contact" : "debt"}:${src.field}`;
}
