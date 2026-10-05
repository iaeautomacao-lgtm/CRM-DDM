// Catálogo versionado das métricas do DDM Intelligence. É a definição
// oficial: o cálculo em compute/* segue exatamente numerator/denominator
// daqui. Mudou a regra → nova versão (não reaproveitar o id com outra
// semântica).
//
// Convenções:
//   - "no período" = instante dentro de [from, to) no horário de Brasília.
//   - Execuções de fluxo (flow_runs) entram pelo started_at no período; os
//     eventos (flow_run_events) dessas execuções entram todos.
//   - Execução de IA = execução com pelo menos um evento de nó ai_agent
//     (node_type = 'ai_agent' na coluna ou em payload.node_type) ou um
//     tool_called/tool_result.
//   - Execução encerrada = status diferente de active/delayed.
//   - Transferência humana = evento 'handoff' cujo payload.reason não é
//     'ai_agent_takeover', ou status handed_off com end_reason diferente de
//     'ai_agent_takeover' (takeover = a IA assumiu a conversa; não é humano).
//   - Falha = status failed ou error.

export type MetricUnit = "count" | "ratio" | "minutes" | "ms";
export type MetricSource = "conversations" | "flow_runs" | "flow_run_events";

export interface MetricDefinition {
  id: string;
  display_name: string;
  description: string;
  unit: MetricUnit;
  numerator: string;
  denominator: string;
  source: MetricSource[];
  version: number;
  reliable_since: string;
  /** scalar = um número para o escopo todo (compare_periods aceita). */
  kind: "scalar" | "breakdown";
}

const CONV_SINCE =
  "first_response_at/last_customer_message_at desde a migration 128; closed_at desde a 130 (antes, backfill aproximado por updated_at)";
const AI_SINCE =
  "tool_called/tool_result só gravam desde a migration 067; node_type/status/duration_ms desde a 061";

export const METRICS: readonly MetricDefinition[] = [
  {
    id: "conversations_total",
    display_name: "Conversas recebidas",
    description: "Conversas criadas no período.",
    unit: "count",
    numerator: "conversas com created_at no período",
    denominator: "1 (contagem)",
    source: ["conversations"],
    version: 1,
    reliable_since: "sempre",
    kind: "scalar",
  },
  {
    id: "conversations_open",
    display_name: "Conversas em aberto",
    description: "Das conversas criadas no período, quantas estão com status 'open' agora (estado atual, não histórico).",
    unit: "count",
    numerator: "conversas criadas no período com status = 'open' no momento da consulta",
    denominator: "1 (contagem)",
    source: ["conversations"],
    version: 1,
    reliable_since: "sempre",
    kind: "scalar",
  },
  {
    id: "conversations_pending",
    display_name: "Conversas pendentes",
    description: "Das conversas criadas no período, quantas estão com status 'pending' agora (estado atual).",
    unit: "count",
    numerator: "conversas criadas no período com status = 'pending' no momento da consulta",
    denominator: "1 (contagem)",
    source: ["conversations"],
    version: 1,
    reliable_since: "sempre",
    kind: "scalar",
  },
  {
    id: "conversations_closed",
    display_name: "Conversas finalizadas",
    description: "Conversas finalizadas no período (closed_at no período), criadas em qualquer data. Mesma regra da aba Hoje do Monitoramento.",
    unit: "count",
    numerator: "conversas com closed_at no período",
    denominator: "1 (contagem)",
    source: ["conversations"],
    version: 1,
    reliable_since: CONV_SINCE,
    kind: "scalar",
  },
  {
    id: "first_response_avg_min",
    display_name: "Tempo médio de 1ª resposta (min)",
    description: "Média de (first_response_at − created_at) das conversas atendidas no período (first_response_at no período), como na aba Hoje do Monitoramento. Só conta resposta de atendente humano.",
    unit: "minutes",
    numerator: "soma dos minutos até a 1ª resposta humana",
    denominator: "conversas com first_response_at no período",
    source: ["conversations"],
    version: 1,
    reliable_since: CONV_SINCE,
    kind: "scalar",
  },
  {
    id: "first_response_p90_min",
    display_name: "1ª resposta — p90 (min)",
    description: "Percentil 90 (nearest-rank) dos minutos até a 1ª resposta humana, mesma amostra da média.",
    unit: "minutes",
    numerator: "amostras ≤ p90",
    denominator: "conversas com first_response_at no período",
    source: ["conversations"],
    version: 1,
    reliable_since: CONV_SINCE,
    kind: "scalar",
  },
  {
    id: "ai_runs",
    display_name: "Execuções com IA",
    description: "Execuções de fluxo iniciadas no período que passaram por um nó de agente de IA.",
    unit: "count",
    numerator: "flow_runs iniciados no período com evento de ai_agent ou tool_called/tool_result",
    denominator: "1 (contagem)",
    source: ["flow_runs", "flow_run_events"],
    version: 1,
    reliable_since: AI_SINCE,
    kind: "scalar",
  },
  {
    id: "ai_handoff_rate",
    display_name: "Taxa de transferência da IA",
    description: "Das execuções com IA já encerradas, a fração que terminou em transferência para humano (takeover da IA não conta).",
    unit: "ratio",
    numerator: "execuções de IA encerradas com transferência humana e sem falha",
    denominator: "execuções de IA iniciadas no período e encerradas",
    source: ["flow_runs", "flow_run_events"],
    version: 1,
    reliable_since: AI_SINCE,
    kind: "scalar",
  },
  {
    id: "ai_failure_rate",
    display_name: "Taxa de falha da IA",
    description: "Das execuções com IA já encerradas, a fração com status failed ou error (qualquer motivo, inclusive ai_agent_failed).",
    unit: "ratio",
    numerator: "execuções de IA encerradas com status failed/error",
    denominator: "execuções de IA iniciadas no período e encerradas",
    source: ["flow_runs", "flow_run_events"],
    version: 1,
    reliable_since: AI_SINCE,
    kind: "scalar",
  },
  {
    id: "ai_containment_rate",
    display_name: "Contenção da IA",
    description:
      "Das execuções com IA já encerradas, a fração resolvida sem humano: não falhou, não foi transferida para humano e não foi pausada por atendente (paused_by_agent). Inclui completed, transferred (outro fluxo), timed_out e ai_agent_takeover. Contenção + transferência + falha + pausada = 1.",
    unit: "ratio",
    numerator: "execuções de IA encerradas sem falha, sem transferência humana e sem paused_by_agent",
    denominator: "execuções de IA iniciadas no período e encerradas",
    source: ["flow_runs", "flow_run_events"],
    version: 1,
    reliable_since: AI_SINCE,
    kind: "scalar",
  },
  {
    id: "fallback_rate",
    display_name: "Taxa de resposta não reconhecida",
    description: "Fração das execuções de fluxo (com ou sem IA) iniciadas no período com pelo menos um fallback_fired.",
    unit: "ratio",
    numerator: "execuções com ≥ 1 evento fallback_fired",
    denominator: "execuções iniciadas no período",
    source: ["flow_runs", "flow_run_events"],
    version: 1,
    reliable_since: "sempre (logEvent desde a 010)",
    kind: "scalar",
  },
  {
    id: "tool_success_rate",
    display_name: "Sucesso das ferramentas da IA",
    description:
      "Fração dos tool_result sem erro. Erro = status 'error' ou resultado JSON com campo 'error' (o motor grava status 'success' mesmo quando a chamada HTTP falha e embrulha a falha em {\"error\": ...}). Respostas HTTP 4xx/5xx sem campo 'error' contam como sucesso (o status HTTP não é gravado).",
    unit: "ratio",
    numerator: "tool_result sem erro",
    denominator: "tool_result das execuções iniciadas no período",
    source: ["flow_run_events"],
    version: 1,
    reliable_since: AI_SINCE,
    kind: "scalar",
  },
  {
    id: "tool_latency_p50_ms",
    display_name: "Latência das ferramentas — p50 (ms)",
    description: "Mediana (nearest-rank) de duration_ms dos tool_result.",
    unit: "ms",
    numerator: "amostras ≤ p50",
    denominator: "tool_result com duration_ms",
    source: ["flow_run_events"],
    version: 1,
    reliable_since: AI_SINCE,
    kind: "scalar",
  },
  {
    id: "tool_latency_p95_ms",
    display_name: "Latência das ferramentas — p95 (ms)",
    description: "Percentil 95 (nearest-rank) de duration_ms dos tool_result.",
    unit: "ms",
    numerator: "amostras ≤ p95",
    denominator: "tool_result com duration_ms",
    source: ["flow_run_events"],
    version: 1,
    reliable_since: AI_SINCE,
    kind: "scalar",
  },
  {
    id: "flow_completion_rate",
    display_name: "Conclusão dos fluxos",
    description: "Das execuções de fluxo iniciadas no período e já encerradas, a fração com status completed.",
    unit: "ratio",
    numerator: "execuções com status completed",
    denominator: "execuções iniciadas no período e encerradas",
    source: ["flow_runs"],
    version: 1,
    reliable_since: "sempre",
    kind: "scalar",
  },
  {
    id: "agent_conversations",
    display_name: "Conversas por atendente",
    description: "Por atendente (assigned_agent_id ATUAL): conversas criadas no período atribuídas a ele.",
    unit: "count",
    numerator: "conversas criadas no período com assigned_agent_id = atendente",
    denominator: "1 (contagem)",
    source: ["conversations"],
    version: 1,
    reliable_since: "sempre",
    kind: "breakdown",
  },
  {
    id: "agent_first_response_avg_min",
    display_name: "1ª resposta por atendente (min)",
    description:
      "Por atendente (assigned_agent_id ATUAL): média dos minutos até a 1ª resposta humana das conversas atendidas no período. Atribuição atual, não necessariamente quem respondeu primeiro.",
    unit: "minutes",
    numerator: "soma dos minutos até a 1ª resposta",
    denominator: "conversas do atendente com first_response_at no período",
    source: ["conversations"],
    version: 1,
    reliable_since: CONV_SINCE,
    kind: "breakdown",
  },
];

export const METRIC_IDS = METRICS.map((m) => m.id);
export const SCALAR_METRIC_IDS = METRICS.filter((m) => m.kind === "scalar").map((m) => m.id);

export function getMetric(id: string): MetricDefinition | undefined {
  return METRICS.find((m) => m.id === id);
}
