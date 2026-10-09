// Log de execução de fluxo em linguagem de gente (PRD-02). Puro — usado
// na página de execuções (/flows/[id]/runs). Os eventos vêm de
// flow_run_events (engine.ts: logEvent / logRunEvent).
//
// Revisão de qualidade dos fluxos (10/10): motivos e erros chegam do motor
// como códigos internos (`send_text_failed`) e texto cru da Meta (em
// inglês, com `code 131047`). Aqui viram frase em português; o erro da
// Meta passa pelo catálogo único (normalizarErroMeta).

import { normalizarErroMeta } from "@/lib/disparador/normalize-meta-error";

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

/** Motivo interno (payload.reason / end_reason) → frase. */
export const REASON_LABEL: Record<string, string> = {
  send_text_failed: "Falha ao enviar a mensagem",
  send_buttons_failed: "Falha ao enviar os botões",
  send_list_failed: "Falha ao enviar a lista",
  send_media_failed: "Falha ao enviar a mídia",
  send_template_failed: "Falha ao enviar o template",
  send_flow_failed: "Falha ao enviar o formulário (WhatsApp Flow)",
  send_webchat_failed: "Falha ao enviar o convite do Webchat",
  set_tag_failed: "Falha ao aplicar a etiqueta",
  add_note_failed: "Falha ao registrar a nota",
  http_fetch_failed: "Falha na chamada HTTP",
  condition_evaluation_failed: "Falha ao avaliar a condição",
  switch_evaluation_failed: "Falha ao avaliar os ramos",
  collect_input_prompt_failed: "Falha ao enviar a pergunta",
  receive_attachment_prompt_failed: "Falha ao pedir o anexo",
  reprompt_send_failed: "Falha ao perguntar de novo",
  smart_delay_message_failed: "Falha ao enviar a mensagem da espera",
  handoff_failed: "Falha ao transferir para humano",
  ai_agent_failed: "A IA falhou",
  ai_config_disabled_or_missing: "IA desativada ou sem configuração",
  missing_provider_api_key: "Chave do provedor de IA não configurada",
  agent_disabled: "Agente de IA desativado",
  agent_unavailable: "Agente de IA indisponível",
  node_not_found: "O nó de destino não existe mais",
  current_node_not_found: "O nó atual não existe mais no fluxo",
  active_run_missing_current_node: "Execução sem nó atual",
  missing_next_node: "O nó não tem próximo passo definido",
  unknown_node_type: "Tipo de nó desconhecido",
  go_to_flow_invalid_target: "O fluxo de destino não existe ou está inativo",
  go_to_hop_limit_exceeded: "Limite de saltos entre âncoras atingido (possível laço)",
  advance_loop_overflow: "Limite de passos seguidos atingido (possível laço)",
  advance_loop_safety_break: "Limite de passos seguidos atingido (possível laço)",
  wake_exception: "Erro ao retomar após a espera",
  fallback_exhausted: "O cliente esgotou as tentativas de resposta",
  fallback_exhausted_end: "O cliente esgotou as tentativas de resposta",
  guard_handoff: "Transferido pela proteção da conversa",
  handoff_anti_loop: "Transferido para evitar repetição em laço",
  handoff_anti_scam: "Transferido por suspeita de golpe",
  ai_response_stalled: "A IA demorou demais para responder",
  ai_agent_takeover: "A IA assumiu a conversa",
  lost_race_during_advance: "Outro evento já tinha avançado esta execução",
};

export const END_REASON_LABEL: Record<string, string> = {
  completed: "chegou ao fim do fluxo",
  end_node: "chegou ao fim do fluxo",
  handoff: "transferido para um atendente",
  handoff_node: "transferido para um atendente",
  handed_off: "transferido para um atendente",
  timeout: "o cliente não respondeu a tempo",
  timed_out: "o cliente não respondeu a tempo",
  stale_sweep: "sem resposta do cliente por tempo demais",
  error: "erro durante a execução",
  failed: "erro durante a execução",
  paused_by_agent: "pausado por um atendente",
  agent_replied: "um atendente respondeu na conversa",
  contact_merged: "contato unido a outro",
  conversation_closed: "conversa finalizada",
  superseded: "substituído por outra execução",
  superseded_by_other_line: "o cliente iniciou outra execução por outra linha",
  go_to_flow: "seguiu para outro fluxo",
  moved_to_webchat: "a conversa seguiu no Webchat",
  webchat_session_ended: "a sessão do Webchat terminou",
};

const OUTCOME_LABEL: Record<string, string> = {
  active: "Em andamento",
  delayed: "Aguardando",
  completed: "Concluído",
  handed_off: "Transferido para humano",
  timed_out: "Tempo esgotado",
  failed: "Falhou",
  error: "Erro",
  paused_by_agent: "Pausado pelo atendente",
  transferred: "Encaminhado a outro fluxo",
};

const MEDIA_LABEL: Record<string, string> = {
  image: "uma imagem",
  video: "um vídeo",
  audio: "um áudio",
  document: "um documento",
  sticker: "uma figurinha",
};

/** Erros que o motor grava mas que não são falha (corrida inofensiva). */
const BENIGN_ERROR_REASONS = new Set(["lost_race_during_advance"]);

const ERROR_TYPES = ["node_error", "run_error", "error", "ai_agent_failed"];

function str(v: unknown, max = 120): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ms(n: number | null): string {
  if (n === null || n === undefined) return "";
  return n >= 1000 ? ` (${(n / 1000).toFixed(1)} s)` : ` (${n} ms)`;
}

/** Rótulo do motivo; `wake_inconsistent:<problema>` vira frase genérica; desconhecido fica cru. */
export function reasonLabel(reason: string): string {
  if (Object.hasOwn(REASON_LABEL, reason)) return REASON_LABEL[reason];
  if (reason.startsWith("wake_inconsistent:")) return "Execução inconsistente ao retomar após a espera";
  return reason;
}

/** Fim da execução em frase (end_reason). */
export function endReasonLabel(reason: string): string {
  return Object.hasOwn(END_REASON_LABEL, reason) ? END_REASON_LABEL[reason] : reasonLabel(reason);
}

/**
 * Texto de erro legível: troca o prefixo de código interno
 * ("send_text_failed: …") pela frase e traduz o erro da Meta pelo catálogo.
 */
export function humanizeError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^([a-z][a-z0-9_]*_(?:failed|exceeded|overflow|missing|exception)):\s*([\s\S]*)$/);
  if (m) {
    const detail = m[2] ? normalizarErroMeta(m[2]) : "";
    return detail ? `${reasonLabel(m[1])}: ${detail}` : reasonLabel(m[1]);
  }
  return normalizarErroMeta(raw);
}

function isBenign(ev: RunEvent): boolean {
  const r = ev.payload?.reason;
  return typeof r === "string" && BENIGN_ERROR_REASONS.has(r);
}

/** Frase do evento, sem o rótulo do nó (a tela mostra o nó ao lado). */
export function describeEvent(ev: RunEvent): string {
  const p = ev.payload ?? {};
  switch (ev.event_type) {
    case "message_sent": {
      if (p.node_type === "send_template" && p.template_name) return `Enviou o template "${String(p.template_name)}"`;
      if (p.node_type === "send_flow") return `Enviou o formulário (WhatsApp Flow${p.flow_id ? ` ${String(p.flow_id)}` : ""})`;
      const text = str(p.text ?? p.body ?? p.content_text ?? p.message, 100);
      const media = typeof p.media_type === "string" ? MEDIA_LABEL[p.media_type] ?? p.media_type : null;
      return text ? `Enviou: "${text}"` : media ? `Enviou ${media}` : "Enviou mensagem";
    }
    case "reply_received": {
      if (p.kind === "flow_response") {
        const fields = Array.isArray(p.fields) ? p.fields.length : 0;
        return `Formulário recebido${p.flow_name ? `: ${String(p.flow_name)}` : ""}${
          fields ? ` (${fields} campo${fields === 1 ? "" : "s"})` : ""
        }`;
      }
      const text = str(p.reply_text ?? p.text ?? p.last_reply ?? p.content_text, 100);
      if (p.reply_id) return `Cliente escolheu a opção "${String(p.reply_id)}"${text ? `: "${text}"` : ""}`;
      return text ? `Cliente respondeu: "${text}"` : "Cliente respondeu";
    }
    case "tool_called": {
      // Só os nomes dos campos: os valores podem trazer CPF e outros dados pessoais.
      const args = p.arguments ?? p.args ?? p.input;
      const keys = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args as object) : [];
      return `IA chamou ${String(p.tool_name ?? "ferramenta")}${keys.length ? ` (campos: ${keys.slice(0, 6).join(", ")})` : ""}`;
    }
    case "tool_result": {
      if (ev.status === "error") {
        const cause = humanizeError(ev.error_message ?? str(p.error, 160));
        return `${String(p.tool_name ?? "Ferramenta")} falhou${ms(ev.duration_ms)}${cause ? `: ${cause}` : ""}`;
      }
      // Eventos novos (migration 212) trazem só o resumo do resultado, nunca o corpo.
      const summary = p.result_summary && typeof p.result_summary === "object" ? (p.result_summary as { format?: unknown; chars?: unknown }) : null;
      const summaryText = summary ? `${String(summary.format ?? "resultado")}, ${String(summary.chars ?? "?")} caracteres` : null;
      const result = str(p.result ?? p.output ?? summaryText, 90);
      return `${String(p.tool_name ?? "Ferramenta")} respondeu${ms(ev.duration_ms)}${result ? `: ${result}` : ""}`;
    }
    case "handoff": {
      const reason = typeof p.reason === "string" ? reasonLabel(p.reason) : null;
      const note = str(p.note, 120) ?? reason;
      const target = p.assigned_to ? " para um atendente definido" : p.team_id ? " para uma equipe" : "";
      return `Transferido para humano${target}${note ? ` — ${note}` : ""}`;
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
    case "run_error": {
      // Fim sem mensagem (tempo esgotado, sessão do Webchat encerrada…):
      // o porquê está no end_reason, não em error_message.
      if (!ev.error_message && typeof p.end_reason === "string") return `Encerrada: ${endReasonLabel(p.end_reason)}`;
      return humanizeError(ev.error_message) ?? "Erro sem detalhe";
    }
    case "ai_agent_failed":
    case "node_error":
    case "error": {
      if (isBenign(ev)) return `${reasonLabel(String(p.reason))} (sem efeito)`;
      const fromMessage = humanizeError(ev.error_message);
      if (fromMessage) return fromMessage;
      const reason = typeof p.reason === "string" ? reasonLabel(p.reason) : null;
      const detail = humanizeError(str(p.detail ?? p.exit_reason ?? p.error, 300));
      return [reason, detail].filter(Boolean).join(": ") || "Erro sem detalhe";
    }
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
    case "node_entered": {
      if (typeof p.captured_key === "string") return `Aguardando resposta para ${p.captured_key}`;
      const next = typeof p.advancing_to === "string" && p.advancing_to ? `, seguiu para ${p.advancing_to}` : "";
      if (typeof p.condition_result === "string") {
        return `Condição ${p.condition_result === "true" ? "verdadeira" : "falsa"}${next}`;
      }
      if (typeof p.switch_result === "string") {
        return p.switch_result === "default" ? `Nenhum ramo bateu: seguiu pelo padrão${next}` : `Ramo "${p.switch_result}"${next}`;
      }
      if ("picker_chosen_agent_id" in p) {
        return p.picker_chosen_agent_id ? "Menu de operadores: cliente escolheu um atendente" : "Menu de operadores: seguiu para a fila";
      }
      return "Entrou no nó";
    }
    default:
      return EVENT_LABEL[ev.event_type] ?? ev.event_type;
  }
}

/** Eventos sem informação para quem lê (escondidos em "Só o importante"). */
export function isRoutineEvent(ev: RunEvent): boolean {
  const p = ev.payload ?? {};
  if (ERROR_TYPES.includes(ev.event_type) && isBenign(ev)) return true;
  if (ev.event_type === "node_entered") {
    return (
      typeof p.captured_key !== "string" &&
      typeof p.condition_result !== "string" &&
      typeof p.switch_result !== "string" &&
      !("picker_chosen_agent_id" in p)
    );
  }
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

/**
 * Falhas reais da execução, uma por ocorrência: o motor grava a mesma
 * falha como `error` + `node_error` + `run_error`; aqui elas viram uma só
 * (mesmo nó e mesma frase). Corridas inofensivas ficam de fora, e o
 * `run_error` sem mensagem (só o fechamento) também.
 */
export function distinctFailures(events: RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!ERROR_TYPES.includes(e.event_type) || isBenign(e)) continue;
    if (e.event_type === "run_error" && !e.error_message) continue;
    const text = describeEvent(e);
    // run_error repete a falha do nó com a mesma mensagem, sem node_key.
    if (e.event_type === "run_error" && out.some((o) => describeEvent(o) === text)) continue;
    const key = `${e.node_key ?? ""}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
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
  const failures = distinctFailures(events);
  const lastNode =
    [...events].reverse().find((e) => e.node_key)?.node_key ?? run.current_node_key ?? null;
  const handoff = [...events].reverse().find((e) => e.event_type === "handoff");
  const outcome = OUTCOME_LABEL[run.status] ?? run.status;
  // Manchete de erro só quando a execução terminou em falha: um erro
  // intermediário já contornado não pode virar "Parou por erro".
  const endedInFailure = run.status === "failed" || run.status === "error";

  let headline: string;
  if (run.status === "active") {
    headline = `Em andamento${lastNode ? `, aguardando em ${lastNode}` : ""}.`;
  } else if (run.status === "delayed") {
    headline = `Em espera programada${lastNode ? ` em ${lastNode}` : ""}; retoma sozinha.`;
  } else if (handoff) {
    const why =
      str(handoff.payload?.note) ?? (typeof handoff.payload?.reason === "string" ? reasonLabel(handoff.payload.reason) : null);
    headline = `Transferido para humano${handoff.node_key ? ` em ${handoff.node_key}` : ""}${why ? `: ${why}` : ""}.`;
  } else if (endedInFailure && failures.length > 0) {
    const last = failures[failures.length - 1];
    headline = `Parou por erro${last.node_key ? ` em ${last.node_key}` : ""}: ${describeEvent(last)}.`;
  } else {
    const reason = run.end_reason ? endReasonLabel(run.end_reason) : null;
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
    errors: failures.length,
  };
}
