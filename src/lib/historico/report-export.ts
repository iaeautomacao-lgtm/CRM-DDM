// Exportação xlsx/csv de conversas no Histórico (veio do relatório Conversas): mesma RPC get_conversations_report,
// mesmas colunas e mesmo tipo de histórico ("conversas"). Permissão: reports.export (o servidor revalida).
import { format } from "date-fns";
import { startOfDayIso, endOfDayIso } from "@/lib/relatorios/date-range";
import type { HistoryPeriod } from "./format";
import type { HistoryRange, HistoryStatus } from "./queries";

export const REPORT_EXPORT_LIMIT = 9999;
const EPOCH_DAY = "2000-01-01";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportRawRow {
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  waha_session: string | null;
  status: string;
  agent_name: string | null;
  team_name: string | null;
  started_at: string;
  ended_at: string | null;
  message_count: string | number;
}

export const REPORT_EXPORT_COLUMNS = [
  { key: "contato", label: "Contato" },
  { key: "telefone", label: "Telefone" },
  { key: "canal", label: "Canal" },
  { key: "status", label: "Status" },
  { key: "agente", label: "Agente" },
  { key: "equipe", label: "Equipe" },
  { key: "iniciadoEm", label: "Iniciado em" },
  { key: "encerradoEm", label: "Encerrado em" },
  { key: "mensagens", label: "Mensagens" },
] as const;

/** Datas locais (yyyy-MM-dd) do recorte atual do Histórico. */
export function exportDateRange(
  period: HistoryPeriod | "custom",
  range: HistoryRange | null,
  now: Date = new Date(),
): { dateFrom: string; dateTo: string } {
  const day = (d: Date) => format(d, "yyyy-MM-dd");
  const today = day(now);
  if (period === "custom") return { dateFrom: range?.from || EPOCH_DAY, dateTo: range?.to || today };
  if (period === "todas") return { dateFrom: EPOCH_DAY, dateTo: today };
  if (period === "hoje") return { dateFrom: today, dateTo: today };
  return { dateFrom: day(new Date(now.getTime() - (period === "7d" ? 7 : 30) * DAY_MS)), dateTo: today };
}

/** Parâmetros da RPC: encerradas filtram pela data de encerramento; as demais, pela de início (mesma regra da lista). */
export function buildReportRpcParams(opts: {
  accountId: string;
  status: HistoryStatus;
  period: HistoryPeriod | "custom";
  range: HistoryRange | null;
  search: string;
}) {
  const { dateFrom, dateTo } = exportDateRange(opts.period, opts.range);
  const term = opts.search.trim();
  return {
    dateFrom,
    dateTo,
    rpc: {
      p_account_id: opts.accountId,
      p_date_from: startOfDayIso(dateFrom),
      p_date_to: endOfDayIso(dateTo),
      p_scope: opts.status === "closed" ? "closed" : "created",
      p_waha_session: null,
      p_agent_id: null,
      p_team_id: null,
      p_status: opts.status === "all" ? null : opts.status,
      p_search: term ? term : null,
      p_limit: REPORT_EXPORT_LIMIT,
      p_offset: 0,
    },
  };
}

/** Linhas da planilha, iguais às do relatório antigo. */
export function toReportExportRows(rows: ReportRawRow[]) {
  return rows.map((r) => ({
    contato: r.contact_name ?? "",
    telefone: r.contact_phone ?? "",
    canal: r.waha_session || "Meta/Webchat",
    status: r.status === "closed" ? "Encerrado" : "Em andamento",
    agente: r.agent_name ?? "",
    equipe: r.team_name ?? "",
    iniciadoEm: format(new Date(r.started_at), "dd/MM/yyyy HH:mm:ss"),
    encerradoEm: r.ended_at ? format(new Date(r.ended_at), "dd/MM/yyyy HH:mm:ss") : "",
    mensagens: Number(r.message_count ?? 0) || 0,
  }));
}
