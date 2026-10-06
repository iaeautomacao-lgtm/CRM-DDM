// Tipos do chat do DDM Intelligence (PRD-04, Fase 2). O laço (loop.ts)
// fala com o modelo por esta interface mínima — a implementação real é
// openai-client.ts, e os testes injetam um cliente falso.

import type { JsonSchemaObject } from "../tools/types";

export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON cru, como o modelo gerou (pode ser inválido). */
  arguments: string;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface LlmCompletionRequest {
  messages: LlmMessage[];
  /** Ausente/vazio = o modelo não pode chamar ferramentas nesta rodada. */
  tools?: LlmToolDefinition[];
  /** Pedaços do texto da resposta, à medida que chegam (streaming). */
  onTextDelta?: (delta: string) => void;
}

export interface LlmCompletion {
  content: string;
  toolCalls: LlmToolCall[];
}

export interface ChatLlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletion>;
}

export type ToolErrorKind =
  | "forbidden"
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "unknown_tool"
  | "internal";

export type ToolExecution =
  | { ok: true; result: unknown; durationMs: number }
  | { ok: false; kind: ToolErrorKind; message: string; durationMs: number };

/** Executa uma chamada de ferramenta pedida pelo modelo (escopo já fixado). */
export type ToolExecutor = (name: string, rawArguments: string) => Promise<ToolExecution>;

/** O que fica salvo em intelligence_messages.tool_calls (sem o resultado). */
export interface ToolCallRecord {
  name: string;
  arguments: unknown;
  ok: boolean;
  error_kind: ToolErrorKind | null;
  duration_ms: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatHistoryMessage {
  role: ChatRole;
  content: string;
}

export type ChatStopReason = "answered" | "max_rounds" | "refused";

export type ChatLoopEvent =
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; ok: boolean; error_kind: ToolErrorKind | null }
  /** Texto já enviado nesta rodada virou preâmbulo de chamada de ferramenta: descartar. */
  | { type: "reset" }
  | { type: "text"; delta: string };

export interface ChatLoopResult {
  answer: string;
  toolCalls: ToolCallRecord[];
  /** Rodadas em que o modelo chamou ferramentas. */
  rounds: number;
  stopReason: ChatStopReason;
}
