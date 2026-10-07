import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleAiAutoResponse } from "@/lib/ai/responder";
import { writeLog } from "@/lib/logger";
import { safeFetch } from "@/lib/security/ssrf-guard";
import { sendSocialMessage } from "@/lib/channels/social";
import { resolveProviderMedia } from "@/lib/storage/provider-media";
import { getConversationChannel, sendWebchatMessage } from "@/lib/webchat/send";
import {
  createWebchatSession,
  hasActiveWebchatSession,
  sendWebchatInvite,
} from "@/lib/webchat/sessions";
import { supabaseAdmin } from "./admin-client";
import {
  engineMetaSendTemplate,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import {
  engineWahaSendButtons,
  engineWahaSendList,
  engineWahaSendMedia,
  engineWahaSendText,
} from "./waha-send";

/**
 * Efeitos externos do motor de fluxos (PRD 05 — simulador).
 *
 * Tudo que o engine.ts faz FORA do próprio processo passa por aqui:
 * banco (cliente service-role), envio Meta/WAHA/Webchat/Instagram, IA
 * (responder), HTTP do nó http_fetch, logs em system_logs, espera do
 * debounce. Ponto único de injeção em vez de `if (simulando)` espalhado.
 *
 * Produção usa `liveFlowEffects`, que chama EXATAMENTE as mesmas funções
 * de antes (cada entrada é um repasse direto, lido na hora da chamada).
 * O simulador troca o conjunto inteiro só dentro de `runWithFlowEffects`
 * (AsyncLocalStorage): o escopo vale para aquela cadeia async e nada mais
 * — uma requisição de webhook rodando ao mesmo tempo continua em
 * `liveFlowEffects`.
 *
 * A bifurcação Meta × WAHA continua no engine.ts (cada provedor tem a sua
 * entrada aqui; nada foi unificado).
 */
export interface FlowEffects {
  readonly mode: "live" | "simulation";
  /** Cliente de banco do motor (wacrm). */
  db(): SupabaseClient;

  // Envio — Meta Cloud API
  engineSendText: typeof engineSendText;
  engineSendMedia: typeof engineSendMedia;
  engineSendInteractiveButtons: typeof engineSendInteractiveButtons;
  engineSendInteractiveList: typeof engineSendInteractiveList;
  engineMetaSendTemplate: typeof engineMetaSendTemplate;
  // Envio — WAHA
  engineWahaSendText: typeof engineWahaSendText;
  engineWahaSendMedia: typeof engineWahaSendMedia;
  engineWahaSendButtons: typeof engineWahaSendButtons;
  engineWahaSendList: typeof engineWahaSendList;
  // Outros canais
  sendWebchatMessage: typeof sendWebchatMessage;
  sendSocialMessage: typeof sendSocialMessage;
  getConversationChannel: typeof getConversationChannel;
  createWebchatSession: typeof createWebchatSession;
  hasActiveWebchatSession: typeof hasActiveWebchatSession;
  sendWebchatInvite: typeof sendWebchatInvite;
  resolveProviderMedia: typeof resolveProviderMedia;

  /** IA do nó ai_agent (modelo + tools + envio da resposta). */
  handleAiAutoResponse: typeof handleAiAutoResponse;
  /**
   * HTTP do nó http_fetch. `nodeKey` só é usado pelo simulador (mocks por nó).
   * Produção passa pelo guard anti-SSRF (safeFetch, #98) com `options.timeoutMs`.
   */
  httpFetch(nodeKey: string, url: string, init: RequestInit, options?: { timeoutMs?: number }): Promise<Response>;
  /** system_logs (best-effort, nunca lança). */
  writeLog: typeof writeLog;
  /** Espera do debounce do ai_agent. */
  sleep(ms: number): Promise<void>;
}

/** Produção: repasse direto para as implementações reais. */
export const liveFlowEffects: FlowEffects = {
  mode: "live",
  db: () => supabaseAdmin(),
  engineSendText: (args) => engineSendText(args),
  engineSendMedia: (args) => engineSendMedia(args),
  engineSendInteractiveButtons: (args) => engineSendInteractiveButtons(args),
  engineSendInteractiveList: (args) => engineSendInteractiveList(args),
  engineMetaSendTemplate: (args) => engineMetaSendTemplate(args),
  engineWahaSendText: (args) => engineWahaSendText(args),
  engineWahaSendMedia: (args) => engineWahaSendMedia(args),
  engineWahaSendButtons: (args) => engineWahaSendButtons(args),
  engineWahaSendList: (args) => engineWahaSendList(args),
  sendWebchatMessage: (msg) => sendWebchatMessage(msg),
  sendSocialMessage: (msg) => sendSocialMessage(msg),
  getConversationChannel: (conversationId) => getConversationChannel(conversationId),
  createWebchatSession: (input) => createWebchatSession(input),
  hasActiveWebchatSession: (conversationId) => hasActiveWebchatSession(conversationId),
  sendWebchatInvite: (input) => sendWebchatInvite(input),
  resolveProviderMedia: (url, accountId) => resolveProviderMedia(url, accountId),
  handleAiAutoResponse: (...args) => handleAiAutoResponse(...args),
  httpFetch: (_nodeKey, url, init, options) =>
    safeFetch(
      url,
      {
        method: init.method,
        headers: init.headers,
        body: typeof init.body === "string" ? init.body : undefined,
        signal: init.signal ?? undefined,
      },
      { timeoutMs: options?.timeoutMs },
    ),
  writeLog: (params) => writeLog(params),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const scope = new AsyncLocalStorage<FlowEffects>();

/** Efeitos do contexto atual — `liveFlowEffects` fora do simulador. */
export function flowEffects(): FlowEffects {
  return scope.getStore() ?? liveFlowEffects;
}

/** Roda `fn` com outro conjunto de efeitos (simulador / testes). */
export function runWithFlowEffects<T>(effects: FlowEffects, fn: () => Promise<T>): Promise<T> {
  return scope.run(effects, fn);
}

type EffectFn = {
  [K in keyof FlowEffects]: FlowEffects[K] extends (...args: never[]) => unknown ? K : never;
}[keyof FlowEffects];

/**
 * Atalho com a mesma assinatura da função real, resolvido a cada chamada
 * — usado no topo do engine.ts para que os call sites não mudem.
 */
export function viaFlowEffects<K extends EffectFn>(key: K): FlowEffects[K] {
  return ((...args: unknown[]) =>
    (flowEffects()[key] as unknown as (...a: unknown[]) => unknown)(...args)) as unknown as FlowEffects[K];
}
