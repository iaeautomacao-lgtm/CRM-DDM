// Escopo do agente (perfil) em execução — AsyncLocalStorage, igual ao escopo de
// segredos da conta. O engine abre o escopo ao redor da chamada da IA de um nó
// vinculado a um agente (`agent_id`); o responder lê a composição do prompt, as
// regras, a seleção da base de conhecimento e as proteções daqui, sem ganhar
// parâmetros novos. Fora de um escopo (nó inline/legado, resposta global),
// nada muda: `currentAgentRuntime()` é null e as proteções valem como sempre.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentComposition, AgentConfig, AgentRule } from "./schema";

export interface AgentRuntimeScope {
  agentId: string;
  /** Versão FIXADA no run (snapshot) — nunca "a publicada agora". */
  versionId: string;
  config: AgentConfig;
  promptContent: string;
  composition: AgentComposition;
  /** Regras já resolvidas (texto) das versões de regra do snapshot. */
  rules: AgentRule[];
}

const scope = new AsyncLocalStorage<AgentRuntimeScope>();

/** Roda `fn` com o agente ativo; com `runtime` nulo, só executa `fn`. */
export function withAgentRuntime<T>(runtime: AgentRuntimeScope | null | undefined, fn: () => Promise<T>): Promise<T> {
  return runtime ? scope.run(runtime, fn) : fn();
}

export function currentAgentRuntime(): AgentRuntimeScope | null {
  return scope.getStore() ?? null;
}

export type ProtectionKey = "anti_xingamento" | "anti_loop" | "pedido_humano_contestacao" | "pessoa_errada";

/**
 * Intenções de prioridade que o PERFIL pode desligar (pessoa errada, pedido de humano,
 * contestação). O OPT-OUT passa SEMPRE: não é opção do perfil e nunca é filtrado aqui.
 */
export function filterPriorityIntent<T extends { kind: string }>(
  intent: T | null,
  runtime: AgentRuntimeScope | null = currentAgentRuntime(),
): T | null {
  if (!intent) return null;
  if (intent.kind === "opt_out") return intent;
  if (intent.kind === "wrong_person") return protectionEnabled("pessoa_errada", runtime) ? intent : null;
  if (intent.kind === "human_request" || intent.kind === "contestation") {
    return protectionEnabled("pedido_humano_contestacao", runtime) ? intent : null;
  }
  return intent;
}

/**
 * Proteção ligada? Padrão LIGADA (sem agente, ou campo ausente). O OPT-OUT não
 * passa por aqui: não é opção do perfil e vale sempre (ver filterPriorityIntent).
 */
export function protectionEnabled(key: ProtectionKey, runtime: AgentRuntimeScope | null = currentAgentRuntime()): boolean {
  const entry = runtime?.config.protections?.[key] as { enabled?: boolean } | undefined;
  return entry?.enabled !== false;
}
