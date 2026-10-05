// Log de execução de fluxo em linguagem de gente (PRD-02). Puro — usado
// na página de execuções (/flows/[id]/runs). Os eventos vêm de
// flow_run_events (engine.ts: logEvent / logRunEvent).

export interface RunEvent {
  event_type: string;
  node_key: string | null;
  node_type: string | null;
  status: "success" | "error" | "skipped" | null;
  error_message: string | null;
  duration_ms: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RunInfo {
  status: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  current_node_key: string | null;
}

export const EVENT_LABEL: Record<string, string> = {
  started: "Execução iniciada",
  run_started: "Execução iniciada",
  node_entered: "Entrou no nó",
  node_completed: "Nó concluído",
  node_error: "Erro no nó",
  message_sent: "Mensagem enviada",
  reply_received: "Cliente respondeu",
  fallback_fired: "Resposta não reconhecida",
  handoff: "Transferido para humano",
  timeout: "Tempo esgotado",
  error: "Erro",
  run_error: "Erro na execução",
  completed: "Execução concluída",
  run_completed: "Execução concluída",
  tool_called: "IA chamou ferramenta",
  tool_result: "Resultado da ferramenta",
  ai_agent_failed: "IA falhou",
  ai_agent_takeover: "IA assumiu a conversa",
};

export const END_REASON_LABEL: Record<string, string> = {
  completed: "chegou ao fim do fluxo",
  handoff: "transferido para um atendente",
  handed_off: "transferido para um atendente",
  timeout: "o cliente não respondeu a tempo",
  timed_out: "o cliente não respondeu a tempo",
  error: "erro durante a execução",
  failed: "erro durante a execução",
  paused_by_agent: "pausado por um atendente",
  contact_merged: "contato unido a outro",
  conversation_closed: "conversa finalizada",
  superseded: "substituído por outra execução",
};

const OUTCOME_LABEL: Record<string, string> = {
  active: "Em andamento",
  completed: "Concluído",
  handed_off: "Transferido para humano",
  timed_out: "Tempo esgotado",
  failed: "Falhou",
  error: "Erro",
  paused_by_agent: "Pausado pelo atendente",
  transferred: "Encaminhado a outro fluxo",
};

function str(v: unknown, max = 120): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ms(n: number | null): string {
  if (n === null || n === undefined) return "";
  return n >= 1000 ? ` (${(n / 1000).toFixed(1)} s)` : ` (${n} ms)`;
}

/** Frase do evento, sem o rótulo do nó (a tela mostra o nó ao lado). */
export function describeEvent(ev: RunEvent): string {
  const p = ev.payload ?? {};
  switch (ev.event_type) {
    case "message_sent": {
      const text = str(p.text ?? p.body ?? p.content_text ?? p.message, 100);
      const media = str(p.media_type, 20);
      return text ? `Enviou: "${text}"` : media ? `Enviou ${media}` : "Enviou mensagem";
    }
    case "reply_received": {
      const text = str(p.reply_text ?? p.text ?? p.last_reply ?? p.content_text, 100);
      if (p.reply_id) return `Cliente escolheu a opção "${String(p.reply_id)}"${text ? `: "${text}"` : ""}`;
      return text ? `Cliente respondeu: "${text}"` : "Cliente respondeu";
    }
    case "tool_called": {
      const args = str(p.arguments ?? p.args ?? p.input, 90);
      return `IA chamou ${String(p.tool_name ?? "ferramenta")}${args ? ` com ${args}` : ""}`;
    }
    case "tool_result": {
      const ok = ev.status !== "error";
      const result = str(p.result ?? p.output, 90);
      return `${String(p.tool_name ?? "Ferramenta")} ${ok ? "respondeu" : "falhou"}${ms(ev.duration_ms)}${
        result ? `: ${result}` : ""
      }`;
    }
    case "handoff": {
      const note = str(p.note ?? p.reason, 120);
      return `Transferido para humano${note ? ` — ${note}` : ""}`;
    }
    case "fallback_fired": {
      const action = p.action === "handoff" ? "transferiu" : p.action === "reprompt" ? "perguntou de novo" : str(p.action);
      const count = typeof p.reprompt_count === "number" ? ` (tentativa ${p.reprompt_count})` : "";
      return `Não entendeu a resposta e ${action ?? "seguiu o padrão"}${count}`;
    }
    case "timeout":
      return "O cliente não respondeu dentro do prazo";
    case "ai_agent_takeover":
      return `IA assumiu a conversa${typeof p.turns_used === "number" ? ` (${p.turns_used} turnos)` : ""}`;
    case "ai_agent_failed":
    case "node_error":
    case "run_error":
    case "error":
      return (
        ev.error_message ||
        [str(p.reason, 60), str(p.detail ?? p.exit_reason ?? p.error, 140)].filter(Boolean).join(": ") ||
        "Erro sem detalhe"
      );
    case "node_completed": {
      if (p.fell_through === true) return "Nenhuma condição bateu: seguiu pelo Senão";
      if (typeof p.branch_chosen === "string") return `Seguiu pelo ramo "${p.branch_chosen}"`;
      if (Array.isArray(p.variables_set)) {
        return (p.variables_set as Array<{ key: string; value: string }>)
          .map((v) => `${v.key} = ${str(v.value, 40)}`)
          .join(" · ");
      }
      if (typeof p.advancing_to === "string") return `Seguiu para ${p.advancing_to}`;
      if (typeof p.last_reply === "string" && p.last_reply) return `Resposta da IA: "${str(p.last_reply, 100)}"`;
      return `Concluído${ms(ev.duration_ms)}`;
    }
    case "node_entered":
      return typeof p.captured_key === "string" ? `Aguardando resposta para ${p.captured_key}` : "Entrou no nó";
    default:
      return EVENT_LABEL[ev.event_type] ?? ev.event_type;
  }
}

/** Eventos sem informação para quem lê (escondidos em "Só o importante"). */
export function isRoutineEvent(ev: RunEvent): boolean {
  const p = ev.payload ?? {};
  if (ev.event_type === "node_entered") return typeof p.captured_key !== "string";
  if (ev.event_type === "node_completed") {
    return (
      ev.status !== "error" &&
      !("fell_through" in p) &&
      !("branch_chosen" in p) &&
      !Array.isArray(p.variables_set) &&
      typeof p.advancing_to !== "string" &&
      !(typeof p.last_reply === "string" && p.last_reply)
    );
  }
  return false;
}

export interface RunSummary {
  outcome: string;
  /** Frase: como e por que terminou (ou onde está). */
  headline: string;
  stoppedAt: string | null;
  durationMs: number | null;
  messagesSent: number;
  replies: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
}

export function summarizeRun(run: RunInfo, events: RunEvent[]): RunSummary {
  const count = (t: string) => events.filter((e) => e.event_type === t).length;
  const errorEvents = events.filter((e) =>
    ["node_error", "run_error", "error", "ai_agent_failed"].includes(e.event_type),
  );
  const lastNode =
    [...events].reverse().find((e) => e.node_key)?.node_key ?? run.current_node_key ?? null;
  const handoff = [...events].reverse().find((e) => e.event_type === "handoff");
  const outcome = OUTCOME_LABEL[run.status] ?? run.status;

  let headline: string;
  if (run.status === "active") {
    headline = `Em andamento${lastNode ? `, aguardando em ${lastNode}` : ""}.`;
  } else if (handoff) {
    headline = `Transferido para humano${handoff.node_key ? ` em ${handoff.node_key}` : ""}${
      str(handoff.payload?.note ?? handoff.payload?.reason) ? `: ${str(handoff.payload?.note ?? handoff.payload?.reason)}` : ""
    }.`;
  } else if (errorEvents.length > 0) {
    const last = errorEvents[errorEvents.length - 1];
    headline = `Parou por erro${last.node_key ? ` em ${last.node_key}` : ""}: ${describeEvent(last)}.`;
  } else {
    const reason = run.end_reason ? END_REASON_LABEL[run.end_reason] ?? run.end_reason : null;
    headline = `${outcome}${reason ? ` — ${reason}` : ""}${lastNode ? ` (último nó: ${lastNode})` : ""}.`;
  }

  return {
    outcome,
    headline,
    stoppedAt: lastNode,
    durationMs: run.ended_at ? Date.parse(run.ended_at) - Date.parse(run.started_at) : null,
    messagesSent: count("message_sent"),
    replies: count("reply_received"),
    toolCalls: count("tool_called"),
    toolErrors: events.filter((e) => e.event_type === "tool_result" && e.status === "error").length,
    errors: errorEvents.length,
  };
}
