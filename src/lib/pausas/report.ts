// Relatório de pausas: consulta e tipos de GET /api/pausas/relatorio
// (contrato em prd-v2/pausas-contrato-api.md). Datas inclusivas, calendário
// de Brasília, no máximo 92 dias.

import type { Pause } from "./pause";

export const REPORT_MAX_DAYS = 92;

export interface PauseReportFilters {
  dateFrom: string;
  dateTo: string;
  teamId: string | null;
  userId: string | null;
  reasonId: string | null;
}

export interface PauseReportAgent {
  user_id: string;
  name: string;
  pauses: number;
  total_seconds: number;
  avg_seconds: number;
  longest_seconds: number;
  exceeded_count: number;
  open_count: number;
  by_reason: { reason_name: string; pauses: number; total_seconds: number; exceeded_count: number }[];
  logged_seconds: number | null;
  pct_of_logged: number | null;
}

export interface PauseReportResponse {
  period: { from: string; to: string };
  agents: PauseReportAgent[];
  items?: Pause[];
  next_cursor: string | null;
}

/** Dias do período, contando as duas pontas (YYYY-MM-DD). NaN se alguma data for inválida. */
export function reportDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** Mensagem se o período não serve para o relatório; null se está certo. */
export function pauseReportRangeError(from: string, to: string): string | null {
  const days = reportDays(from, to);
  if (!Number.isFinite(days)) return "Informe as duas datas.";
  if (days < 1) return "A data final não pode ser anterior à inicial.";
  if (days > REPORT_MAX_DAYS) return `O período pode ter no máximo ${REPORT_MAX_DAYS} dias.`;
  return null;
}

export function buildPauseReportQuery(
  f: PauseReportFilters,
  opts: { detail?: boolean; limit?: number; cursor?: string | null } = {},
): string {
  const qs = new URLSearchParams({ de: f.dateFrom, ate: f.dateTo });
  if (f.teamId) qs.set("equipe", f.teamId);
  if (f.userId) qs.set("atendente", f.userId);
  if (f.reasonId) qs.set("motivo", f.reasonId);
  if (opts.detail) qs.set("detalhe", "1");
  if (opts.limit) qs.set("limite", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  return qs.toString();
}
