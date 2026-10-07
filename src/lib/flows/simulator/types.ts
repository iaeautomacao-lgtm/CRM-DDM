// Tipos do simulador de fluxo (PRD 05) compartilhados entre a rota
// POST /api/flows/[id]/simulate e o painel "Testar fluxo" do editor.
// Arquivo só de tipos/constantes puras — pode ser importado no cliente.

import type { FlowRunRow } from "../types";

/** Tabelas que o cliente guarda entre uma mensagem e outra. */
export const SIM_STATE_TABLES = [
  "flow_runs",
  "flow_run_events",
  "messages",
  "conversations",
  "contacts",
  "contact_tags",
  "contact_notes",
  "ai_decisions",
] as const;
export type SimStateTable = (typeof SIM_STATE_TABLES)[number];

/** Estado completo de uma simulação — vai e volta a cada mensagem. */
export interface SimState {
  version: 1;
  tables: Partial<Record<SimStateTable, Array<Record<string, unknown>>>>;
  clock: number;
  seq: number;
}

/** Contato fictício da simulação. */
export interface SimContactInput {
  name: string;
  phone: string;
  /** Variáveis iniciais do run (ex.: as que a campanha preencheria). */
  vars: Record<string, string>;
}

/** Nó do rascunho do editor (o que ainda não foi publicado). */
export interface SimDraftNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface SimDraftFlow {
  entry_node_id: string | null;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  fallback_policy?: Record<string, unknown> | null;
  nodes: SimDraftNode[];
}

export type SimInboundMessage =
  | { kind: "text"; text: string }
  | { kind: "interactive_reply"; reply_id: string; reply_title: string };

export interface SimulateRequest {
  draft: SimDraftFlow;
  message: SimInboundMessage;
  /** null = começar do zero (botão Reiniciar). */
  state: SimState | null;
  contact: SimContactInput;
  /** Provedor fictício da linha: escolhe o caminho Meta ou WAHA do motor. */
  provider: "meta" | "waha";
  /** true = começa o fluxo em qualquer mensagem (ignora o gatilho). */
  ignoreTrigger: boolean;
  /** Resposta simulada por tool (texto/JSON devolvido ao modelo). */
  toolMocks: Record<string, string>;
  /** Tools somente-leitura que o usuário liberou para chamada real. */
  realReadOnlyTools: string[];
  /** Resposta simulada por nó http_fetch (node_key → corpo). */
  httpMocks: Record<string, string>;
}

export type SimOutboundKind = "text" | "media" | "buttons" | "list" | "template" | "webchat_invite";

/** Mensagem que o cliente receberia (capturada — nada é enviado). */
export interface SimOutbound {
  id: string;
  at: string;
  kind: SimOutboundKind;
  /** Caminho do motor que teria sido usado. */
  provider: "meta" | "waha";
  /** "ia" quando veio do nó ai_agent. */
  source: "flow" | "ia";
  text: string;
  /** Botões / linhas de lista — clicáveis no painel quando Meta. */
  options?: Array<{ id: string; title: string }>;
  media_url?: string | null;
}

export type SimTimelineType =
  | "node"
  | "branch"
  | "tag"
  | "tool_call"
  | "tool_result"
  | "handoff"
  | "run_end"
  | "error"
  | "note";

export interface SimTimelineEvent {
  at: string;
  type: SimTimelineType;
  node_key: string | null;
  label: string;
  detail?: unknown;
}

export interface SimRunSnapshot {
  id: string;
  status: FlowRunRow["status"];
  current_node_key: string | null;
  vars: Record<string, unknown>;
  end_reason: string | null;
}

export interface SimulateResponse {
  state: SimState;
  outbound: SimOutbound[];
  timeline: SimTimelineEvent[];
  run: SimRunSnapshot | null;
  /** Nós percorridos nesta mensagem, em ordem. */
  path: string[];
  dispatch: { consumed: boolean; outcome: string };
  /** Mensagens simuladas restantes na janela do limite por usuário. */
  remaining: number;
}

/** Tools que podem consultar a API real (só GET, com aviso no painel). */
export const SIM_READ_ONLY_TOOLS: readonly string[] = ["localizar_devedor", "consultar_debitos"];
/** Tools com efeito — nunca chamadas de verdade no simulador. */
export const SIM_NEVER_REAL_TOOLS: readonly string[] = ["efetiva_acordo"];

/**
 * Modo efetivo de uma tool no simulador. Real só quando TUDO vale: o
 * usuário liberou, está na lista de somente-leitura, não está na lista de
 * "nunca real" e o método é GET. Qualquer outra coisa → mock.
 */
export function effectiveSimToolMode(
  toolName: string,
  method: string | undefined,
  realReadOnlyTools: readonly string[],
): "mock" | "real_readonly" {
  if (SIM_NEVER_REAL_TOOLS.includes(toolName)) return "mock";
  if (!SIM_READ_ONLY_TOOLS.includes(toolName)) return "mock";
  if ((method ?? "").toUpperCase() !== "GET") return "mock";
  return realReadOnlyTools.includes(toolName) ? "real_readonly" : "mock";
}

/** Limite de custo: mensagens simuladas por usuário na janela. */
export const SIM_RATE_LIMIT = { limit: 30, windowMs: 10 * 60_000 } as const;
