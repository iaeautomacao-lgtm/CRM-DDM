// Textos de interface do chat (seguros para o cliente: sem I/O).

/** Evento NDJSON enviado por POST /api/intelligence/chat, uma linha por evento. */
export type ChatStreamEvent =
  | { type: "meta"; chat_id: string; title: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; ok: boolean; error_kind: string | null }
  | { type: "reset" }
  | { type: "text"; delta: string }
  | { type: "done"; message_id: string | null }
  | { type: "error"; message: string };

const TOOL_LABELS: Record<string, string> = {
  get_overview_metrics: "Consultando a visão geral",
  compare_periods: "Comparando períodos",
  get_ai_performance: "Consultando o desempenho da IA",
  get_ai_handoff_analysis: "Analisando as transferências da IA",
  get_tool_performance: "Consultando as ferramentas da IA",
  get_flow_performance: "Consultando os fluxos",
  get_agent_performance: "Consultando os atendentes",
  compare_institutions: "Comparando instituições",
  search_conversations: "Buscando conversas",
  get_conversation_timeline: "Lendo a conversa",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Consultando ${name}`;
}

export const SUGGESTED_QUESTIONS: readonly string[] = [
  "Como foi o atendimento nos últimos 7 dias?",
  "Por que a taxa de transferência da IA subiu ontem?",
  "Qual instituição teve melhor desempenho esta semana?",
  "Mostre 5 conversas em que a IA transferiu para atendente hoje",
  "Compare esta semana com a semana anterior",
  "Quais atendentes tiveram o maior tempo de primeira resposta este mês?",
];
