import { dayBounds, todayInBrazil } from "./day-view";

// Métricas por atendente da aba Agentes: GET /api/monitoramento/agentes?from=&to= (1ª resposta média e conversas resolvidas).
// "Hoje" usa o dia de Brasília (mesma regra da aba Hoje); "7 dias" é a janela padrão da API.

export type AgentMetricsPeriod = "hoje" | "7d";

export interface AgentMetrics {
  agent_id: string;
  first_response_count: number;
  first_response_avg_seconds: number | null;
  resolved_count: number;
}

export interface AgentMetricsResponse {
  from: string;
  to: string;
  agents: AgentMetrics[];
}

/** Janela do período, em ISO: Hoje = meia-noite de Brasília até agora; 7 dias = os 7 dias até agora. */
export function agentMetricsRange(period: AgentMetricsPeriod, nowMs: number = Date.now()): { from: string; to: string } {
  const to = new Date(nowMs).toISOString();
  if (period === "7d") return { from: new Date(nowMs - 7 * 86_400_000).toISOString(), to };
  return { from: new Date(dayBounds(todayInBrazil(nowMs)).startMs).toISOString(), to };
}

export function indexMetricsByAgent(agents: ReadonlyArray<AgentMetrics>): Map<string, AgentMetrics> {
  return new Map(agents.map((a) => [a.agent_id, a]));
}

/** "45 s", "12 min", "1 h 05 min"; "—" quando não houve 1ª resposta no período. */
export function formatFirstResponse(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}
