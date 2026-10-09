import { describe, expect, it } from "vitest";
import { describeEvent, distinctFailures, humanizeError, isRoutineEvent, summarizeRun, type RunEvent } from "./run-log";

const ev = (over: Partial<RunEvent>): RunEvent => ({
  event_type: "node_entered",
  node_key: null,
  node_type: null,
  status: null,
  error_message: null,
  duration_ms: null,
  payload: {},
  created_at: "2026-10-05T12:00:00Z",
  ...over,
});

describe("describeEvent", () => {
  it("ferramenta da IA com duração e resultado", () => {
    expect(
      describeEvent(ev({ event_type: "tool_result", status: "success", duration_ms: 820, payload: { tool_name: "consulta_debito", result: "ok" } })),
    ).toBe("consulta_debito respondeu (820 ms): ok");
    expect(describeEvent(ev({ event_type: "tool_result", status: "error", payload: { tool_name: "x" } }))).toBe("x falhou");
  });
  it("resposta do cliente e escolha de botão", () => {
    expect(describeEvent(ev({ event_type: "reply_received", payload: { text: "quero negociar" } }))).toBe(
      'Cliente respondeu: "quero negociar"',
    );
    expect(describeEvent(ev({ event_type: "reply_received", payload: { reply_id: "sim" } }))).toBe(
      'Cliente escolheu a opção "sim"',
    );
  });
  it("usa reply_text do engine e o motivo de erros genéricos", () => {
    expect(describeEvent(ev({ event_type: "reply_received", payload: { reply_text: "2" } }))).toBe('Cliente respondeu: "2"');
    expect(describeEvent(ev({ event_type: "error", payload: { reason: "send_text_failed", detail: "429" } }))).toBe(
      "Falha ao enviar a mensagem: 429",
    );
  });

  it("transferência com motivo e erro com mensagem", () => {
    expect(describeEvent(ev({ event_type: "handoff", payload: { note: "pediu atendente" } }))).toBe(
      "Transferido para humano — pediu atendente",
    );
    expect(describeEvent(ev({ event_type: "node_error", error_message: "timeout na API" }))).toBe("timeout na API");
  });
  it("ramo de condição", () => {
    expect(describeEvent(ev({ event_type: "node_completed", payload: { fell_through: true } }))).toBe(
      "Nenhuma condição bateu: seguiu pelo Senão",
    );
  });
});

describe("isRoutineEvent", () => {
  it("esconde entrada/conclusão sem conteúdo, mantém ramos e erros", () => {
    expect(isRoutineEvent(ev({ event_type: "node_entered" }))).toBe(true);
    expect(isRoutineEvent(ev({ event_type: "node_completed" }))).toBe(true);
    expect(isRoutineEvent(ev({ event_type: "node_completed", payload: { branch_chosen: "a" } }))).toBe(false);
    expect(isRoutineEvent(ev({ event_type: "message_sent" }))).toBe(false);
  });
});

describe("summarizeRun", () => {
  const run = { status: "handed_off", started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T12:05:00Z", end_reason: "handoff", current_node_key: null };
  it("explica a transferência e conta mensagens e ferramentas", () => {
    const s = summarizeRun(run, [
      ev({ event_type: "message_sent", node_key: "menu" }),
      ev({ event_type: "tool_called", node_key: "ia" }),
      ev({ event_type: "tool_result", node_key: "ia", status: "error", payload: { tool_name: "boleto" } }),
      ev({ event_type: "handoff", node_key: "ia", payload: { note: "ferramenta falhou" } }),
    ]);
    expect(s.headline).toBe("Transferido para humano em ia: ferramenta falhou.");
    expect(s).toMatchObject({ messagesSent: 1, toolCalls: 1, toolErrors: 1, durationMs: 300_000 });
  });
  it("em andamento mostra onde está", () => {
    const s = summarizeRun({ ...run, status: "active", ended_at: null, end_reason: null, current_node_key: "aguarda_cpf" }, []);
    expect(s.headline).toBe("Em andamento, aguardando em aguarda_cpf.");
  });
});

describe("revisão de qualidade (10/10)", () => {
  it("traduz o prefixo interno e o erro da Meta pelo catálogo", () => {
    const meta = "send_text_failed: Meta: Re-engagement message (code 131047)";
    const out = humanizeError(meta) ?? "";
    expect(out.startsWith("Falha ao enviar a mensagem: ")).toBe(true);
    expect(out).not.toContain("131047");
    expect(humanizeError("erro qualquer")).toBe("erro qualquer");
    expect(humanizeError(null)).toBeNull();
  });

  it("run_error sem mensagem explica o fim pelo end_reason", () => {
    expect(describeEvent(ev({ event_type: "run_error", payload: { end_reason: "stale_sweep" } }))).toBe(
      "Encerrada: sem resposta do cliente por tempo demais",
    );
    expect(describeEvent(ev({ event_type: "run_error", payload: { end_reason: "wake_inconsistent:no_next_node" } }))).toBe(
      "Encerrada: Execução inconsistente ao retomar após a espera",
    );
  });

  it("template, formulário e mídia com descrição própria", () => {
    expect(describeEvent(ev({ event_type: "message_sent", payload: { node_type: "send_template", template_name: "boleto" } }))).toBe(
      'Enviou o template "boleto"',
    );
    expect(describeEvent(ev({ event_type: "message_sent", payload: { node_type: "send_flow", flow_id: "123" } }))).toBe(
      "Enviou o formulário (WhatsApp Flow 123)",
    );
    expect(describeEvent(ev({ event_type: "message_sent", payload: { media_type: "image" } }))).toBe("Enviou uma imagem");
    expect(
      describeEvent(ev({ event_type: "reply_received", payload: { kind: "flow_response", flow_name: "Cadastro", fields: ["flow_nome", "flow_cpf"] } })),
    ).toBe("Formulário recebido: Cadastro (2 campos)");
  });

  it("não mostra valores dos argumentos da IA (dados pessoais)", () => {
    const out = describeEvent(ev({ event_type: "tool_called", payload: { tool_name: "consulta", arguments: { cpf: "12345678900" } } }));
    expect(out).toBe("IA chamou consulta (campos: cpf)");
    expect(out).not.toContain("123456");
  });

  it("ferramenta que falha mostra a causa", () => {
    expect(describeEvent(ev({ event_type: "tool_result", status: "error", error_message: "timeout", payload: { tool_name: "x" } }))).toBe(
      "x falhou: timeout",
    );
  });

  it("ramo de condição, switch e menu de operadores aparecem e não são rotina", () => {
    const cond = ev({ event_type: "node_entered", payload: { condition_result: "false", advancing_to: "fim" } });
    expect(describeEvent(cond)).toBe("Condição falsa, seguiu para fim");
    expect(isRoutineEvent(cond)).toBe(false);
    expect(describeEvent(ev({ event_type: "node_entered", payload: { switch_result: "default" } }))).toBe(
      "Nenhum ramo bateu: seguiu pelo padrão",
    );
    const picker = ev({ event_type: "node_entered", payload: { picker_chosen_agent_id: null } });
    expect(describeEvent(picker)).toBe("Menu de operadores: seguiu para a fila");
    expect(isRoutineEvent(picker)).toBe(false);
  });

  it("uma falha gravada 3x conta uma vez; corrida inofensiva não conta", () => {
    const events = [
      ev({ event_type: "error", node_key: "msg", payload: { reason: "send_text_failed", detail: "429" } }),
      ev({ event_type: "node_error", node_key: "msg", error_message: "send_text_failed: 429" }),
      ev({ event_type: "run_error", error_message: "send_text_failed: 429", payload: { end_reason: "send_text_failed" } }),
      ev({ event_type: "error", node_key: "x", payload: { reason: "lost_race_during_advance" } }),
    ];
    expect(distinctFailures(events)).toHaveLength(1);
    expect(isRoutineEvent(events[3])).toBe(true);
  });

  it("execução concluída com corrida inofensiva não vira 'Parou por erro'", () => {
    const s = summarizeRun(
      { status: "completed", started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T12:01:00Z", end_reason: "end_node", current_node_key: null },
      [ev({ event_type: "error", node_key: "a", payload: { reason: "lost_race_during_advance" } })],
    );
    expect(s.headline).toBe("Concluído — chegou ao fim do fluxo (último nó: a).");
    expect(s.errors).toBe(0);
  });

  it("status delayed tem rótulo", () => {
    const s = summarizeRun(
      { status: "delayed", started_at: "2026-10-05T12:00:00Z", ended_at: null, end_reason: null, current_node_key: "espera" },
      [],
    );
    expect(s.headline).toBe("Em espera programada em espera; retoma sozinha.");
  });
});
