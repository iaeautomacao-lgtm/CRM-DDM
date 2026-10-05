// Etapas de uma tentativa de resposta da IA (handleAiAutoResponse).
//
// Antes, quando a IA não respondia, os logs só diziam "não respondeu" — sem
// dizer ONDE parou. Cada tentativa agora marca a última etapa alcançada; a
// tentativa que não termina em "sent" (ou que precisou de nova tentativa)
// vira um log `ai_attempt` com a etapa em texto: "falhou antes do modelo",
// "parou na ferramenta localizar_devedor", "falhou no envio ao cliente"…

export type AiAttemptPhase =
  | "started" // antes de reservar a mensagem (config, debounce, histórico)
  | "claimed" // mensagem reservada (claim_ai_reply)
  | "llm" // chamando o modelo
  | "tool" // executando uma tool
  | "send" // enviando ao cliente (WhatsApp/canal)
  | "persisted"; // resposta gravada no Inbox

export interface AiAttemptTrace {
  phase: AiAttemptPhase;
  /** Tools chamadas nesta tentativa, em ordem. */
  tools: string[];
  startedAt: number;
}

export function newAttemptTrace(now: number = Date.now()): AiAttemptTrace {
  return { phase: "started", tools: [], startedAt: now };
}

/** Frase curta (pt-BR) dizendo onde a tentativa parou. */
export function describeAttemptStop(
  trace: Pick<AiAttemptTrace, "phase" | "tools">,
  outcome: "sent" | "skipped" | "failed" | "error",
): string {
  if (outcome === "sent") return "Resposta enviada e gravada";
  const lastTool = trace.tools[trace.tools.length - 1];
  switch (trace.phase) {
    case "started":
      return "Parou antes de reservar a mensagem (configuração, histórico ou mensagem já atendida)";
    case "claimed":
      return "Parou depois de reservar a mensagem, antes de chamar o modelo";
    case "llm":
      return lastTool
        ? `Parou no modelo depois da ferramenta ${lastTool}`
        : "Parou na chamada ao modelo (provedor da IA)";
    case "tool":
      return `Parou na ferramenta ${lastTool ?? "(sem nome)"}`;
    case "send":
      return "Parou no envio ao cliente";
    case "persisted":
      return "Enviado e gravado, mas o resultado final não foi \"enviado\"";
  }
}
