import { describe, expect, it } from "vitest";
import { describeEvent, isRoutineEvent, summarizeRun, type RunEvent } from "./run-log";

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
      "send_text_failed: 429",
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
