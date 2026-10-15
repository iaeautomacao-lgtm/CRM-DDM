// Exportação xlsx/csv do relatório de pausas (uma linha por pausa), registrada em
// Exportações como tipo "pausas" (POST /api/relatorios/exports). Permissão: reports.export.

import { format } from "date-fns";
import { endKindLabel, formatPauseDuration, type Pause } from "./pause";

export const PAUSE_EXPORT_COLUMNS = [
  { key: "atendente", label: "Atendente" },
  { key: "motivo", label: "Motivo" },
  { key: "limite", label: "Limite (min)" },
  { key: "inicio", label: "Início" },
  { key: "fim", label: "Fim" },
  { key: "duracao", label: "Duração" },
  { key: "passouDoTempo", label: "Passou do tempo" },
  { key: "quemPausou", label: "Quem pausou" },
  { key: "comoTerminou", label: "Como terminou" },
] as const;

const dateTime = (iso: string) => format(new Date(iso), "dd/MM/yyyy HH:mm");

export function toPauseExportRows(items: Pause[]): Record<string, unknown>[] {
  return items.map((p) => ({
    atendente: p.user_name ?? "",
    motivo: p.reason_name,
    limite: p.max_minutes ?? "",
    inicio: dateTime(p.started_at),
    fim: p.ended_at ? dateTime(p.ended_at) : "Em andamento",
    duracao: formatPauseDuration(p.elapsed_seconds),
    passouDoTempo: p.exceeded ? "Sim" : "Não",
    quemPausou: p.by_supervisor ? (p.started_by_name ?? "Supervisor") : "O próprio atendente",
    comoTerminou: endKindLabel(p.end_kind),
  }));
}
