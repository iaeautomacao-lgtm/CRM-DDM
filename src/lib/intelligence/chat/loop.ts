// Laço de tool-calling do chat do DDM Intelligence (PRD-04, Fase 2).
//
//   pergunta → modelo → (chamadas de ferramenta → executor → modelo)* → resposta
//
// - No máximo `maxRounds` rodadas com ferramentas (padrão 6). Esgotou: uma
//   última chamada SEM ferramentas pede a resposta com o que já foi obtido.
// - Erro de escopo (forbidden) encerra a coleta: a próxima chamada vai sem
//   ferramentas, então o modelo só pode recusar — não tem como "tentar outra
//   consulta" para contornar o escopo.
// - Erros de ferramenta voltam ao modelo como resultado estruturado; erro
//   interno não vaza a mensagem crua.
// Sem I/O próprio: modelo e executor são injetados (testável).

import type {
  ChatHistoryMessage,
  ChatLlmClient,
  ChatLoopEvent,
  ChatLoopResult,
  ChatStopReason,
  LlmMessage,
  LlmToolDefinition,
  ToolCallRecord,
  ToolExecution,
  ToolExecutor,
} from "./types";
import { parseToolArguments } from "./execute";

export const MAX_TOOL_ROUNDS = 6;
/** Teto do JSON de resultado repassado ao modelo (custo de tokens). */
export const MAX_TOOL_RESULT_CHARS = 24_000;

export const MAX_ROUNDS_INSTRUCTION =
  "Limite de consultas desta pergunta atingido. Responda agora apenas com os dados já obtidos pelas ferramentas, sem chamar outras, e diga que a análise pode estar incompleta.";
export const REFUSAL_INSTRUCTION =
  "Uma consulta foi recusada por estar fora do escopo de acesso deste usuário. Recuse educadamente essa parte do pedido, sem tentar outra consulta para contorná-la.";
export const EMPTY_ANSWER_FALLBACK =
  "Não consegui montar uma resposta com os dados disponíveis. Tente reformular a pergunta ou indicar o período.";

/** Conteúdo da mensagem `tool` enviada ao modelo. */
export function toolMessageContent(exec: ToolExecution): string {
  if (exec.ok) {
    let json: string;
    try {
      json = JSON.stringify(exec.result ?? null);
    } catch {
      json = JSON.stringify({ erro: "resultado_invalido" });
    }
    if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
    return JSON.stringify({
      resultado_parcial: json.slice(0, MAX_TOOL_RESULT_CHARS),
      aviso: "Resultado cortado por tamanho. Peça um período menor ou um filtro para ver tudo.",
    });
  }
  switch (exec.kind) {
    case "forbidden":
      return JSON.stringify({
        erro: "fora_do_escopo",
        mensagem: exec.message,
        instrucao: "Esses dados estão fora do escopo de acesso deste usuário. Recuse; não tente contornar.",
      });
    case "rate_limited":
      return JSON.stringify({
        erro: "limite_de_consultas",
        mensagem: "Limite de consultas por minuto atingido. Peça ao usuário para tentar de novo em instantes.",
      });
    case "internal":
      return JSON.stringify({
        erro: "falha_interna",
        mensagem: "Falha ao consultar os dados. Informe ao usuário que não foi possível obter essa informação agora.",
      });
    default:
      // bad_request / not_found / unknown_tool: a mensagem foi escrita para o modelo corrigir a chamada.
      return JSON.stringify({ erro: exec.kind, mensagem: exec.message });
  }
}

export interface RunChatLoopOptions {
  llm: ChatLlmClient;
  systemPrompt: string;
  /** Mensagens anteriores do chat (mais antiga primeiro), sem a pergunta atual. */
  history: ChatHistoryMessage[];
  userMessage: string;
  tools: LlmToolDefinition[];
  execute: ToolExecutor;
  maxRounds?: number;
  onEvent?: (event: ChatLoopEvent) => void;
}

export async function runChatLoop(opts: RunChatLoopOptions): Promise<ChatLoopResult> {
  const maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
  const emit = opts.onEvent ?? (() => {});
  const messages: LlmMessage[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.history.map((m): LlmMessage => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.userMessage },
  ];
  const toolCalls: ToolCallRecord[] = [];
  let rounds = 0;
  let stopReason: ChatStopReason = "answered";

  for (;;) {
    const allowTools = stopReason === "answered" && rounds < maxRounds && opts.tools.length > 0;
    if (!allowTools && stopReason === "answered") stopReason = "max_rounds";
    if (!allowTools) {
      messages.push({
        role: "system",
        content: stopReason === "refused" ? REFUSAL_INSTRUCTION : MAX_ROUNDS_INSTRUCTION,
      });
    }

    let streamed = false;
    const completion = await opts.llm.complete({
      messages,
      tools: allowTools ? opts.tools : undefined,
      onTextDelta: (delta) => {
        if (!delta) return;
        streamed = true;
        emit({ type: "text", delta });
      },
    });

    // Sem ferramentas permitidas, chamadas pedidas mesmo assim são ignoradas.
    if (!allowTools || completion.toolCalls.length === 0) {
      let answer = completion.content.trim();
      if (!answer) {
        answer = EMPTY_ANSWER_FALLBACK;
        if (streamed) emit({ type: "reset" });
        emit({ type: "text", delta: answer });
      } else if (!streamed) {
        emit({ type: "text", delta: answer });
      }
      return { answer, toolCalls, rounds, stopReason };
    }

    if (streamed) emit({ type: "reset" });
    rounds += 1;
    messages.push({ role: "assistant", content: completion.content || null, tool_calls: completion.toolCalls });

    for (const call of completion.toolCalls) {
      emit({ type: "tool_start", name: call.name });
      const exec = await opts.execute(call.name, call.arguments);
      const parsed = parseToolArguments(call.arguments);
      toolCalls.push({
        name: call.name,
        arguments: parsed.ok ? parsed.value : { _raw: call.arguments.slice(0, 500) },
        ok: exec.ok,
        error_kind: exec.ok ? null : exec.kind,
        duration_ms: Math.max(0, Math.round(exec.durationMs)),
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: toolMessageContent(exec) });
      emit({ type: "tool_end", name: call.name, ok: exec.ok, error_kind: exec.ok ? null : exec.kind });
      if (!exec.ok && exec.kind === "forbidden") stopReason = "refused";
    }
  }
}
