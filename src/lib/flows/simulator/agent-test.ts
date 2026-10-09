// "Testar agente" no editor do agente (TASK1-C): reaproveita o simulador de fluxo com um fluxo SINTÉTICO de um
// nó ai_agent ligado ao agente em teste. Módulo puro (sem I/O): monta o rascunho do fluxo e resume a resposta
// para o painel, sem CPF (argumentos e resultados de ferramenta, rótulos e variáveis do run).

import { maskCpfInText, maskPiiArgs } from "@/lib/privacy/mask";
import type { SimDraftFlow, SimRunSnapshot, SimTimelineEvent } from "./types";

export const AGENT_TEST_NODE_KEY = "agente";
/** Resultado de ferramenta mostrado no painel: resumo, não o corpo inteiro. */
export const AGENT_TEST_RESULT_CHARS = 600;

/** Fluxo de um nó: início → nó de IA vinculado ao agente (o comportamento vem todo do agente). */
export function buildAgentTestFlow(agentId: string): SimDraftFlow {
  return {
    entry_node_id: "inicio",
    trigger_type: "first_inbound_message",
    trigger_config: {},
    fallback_policy: null,
    nodes: [
      { node_key: "inicio", node_type: "start", config: { next_node_key: AGENT_TEST_NODE_KEY } },
      { node_key: AGENT_TEST_NODE_KEY, node_type: "ai_agent", config: { agent_id: agentId } },
    ],
  };
}

function summarize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const masked = maskPiiArgs(value);
  const text = typeof masked === "string" ? masked : JSON.stringify(masked);
  return text.length > AGENT_TEST_RESULT_CHARS ? `${text.slice(0, AGENT_TEST_RESULT_CHARS)}…` : text;
}

/** Linha do tempo para o painel: CPF mascarado em tudo e resultado de ferramenta resumido. */
export function summarizeAgentTestTimeline(events: SimTimelineEvent[]): SimTimelineEvent[] {
  return events.map((ev) => {
    const label = maskCpfInText(ev.label);
    if (ev.type === "tool_result") return { ...ev, label, detail: summarize(ev.detail) };
    return { ...ev, label, detail: ev.detail === undefined ? undefined : maskPiiArgs(ev.detail) };
  });
}

export function maskAgentTestRun(run: SimRunSnapshot | null): SimRunSnapshot | null {
  if (!run) return null;
  return { ...run, vars: maskPiiArgs(run.vars) };
}
