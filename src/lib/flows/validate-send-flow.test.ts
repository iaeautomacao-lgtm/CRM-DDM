// PRD 21.4 — validação do nó send_flow (convite para um WhatsApp Flow).
import { describe, expect, it } from "vitest";

import { validateFlowForActivation } from "./validate";

const validFlow = {
  name: "Negociação",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["acordo"] },
  entry_node_id: "start",
};

const flowNodes = (config: Record<string, unknown>) => [
  { node_key: "start", node_type: "start", config: { next_node_key: "form" } },
  { node_key: "form", node_type: "send_flow", config },
  { node_key: "ho", node_type: "handoff", config: { reason_code: "INDEFINIDO" } },
];

const good = { flow_id: "495819284729182", cta_text: "Negociar", body_text: "Olá {{vars.nome}}", flow_action: "data_exchange", next_node_key: "ho" };
const fields = (config: Record<string, unknown>) =>
  validateFlowForActivation(validFlow, flowNodes(config)).filter((i) => i.node_key === "form").map((i) => i.field);

describe("validateFlowForActivation — nó send_flow", () => {
  it("config completa não gera problema (data_exchange não exige tela; navigate exige)", () => {
    expect(validateFlowForActivation(validFlow, flowNodes(good))).toEqual([]);
    expect(validateFlowForActivation(validFlow, flowNodes({ ...good, flow_action: "navigate", screen_id: "SELECAO" }))).toEqual([]);
  });

  it("aponta id do Flow, botão, mensagem, título, ação, tela (navigate) e próximo nó", () => {
    expect(fields({ ...good, flow_id: "abc" })).toContain("flow_id");
    expect(fields({ ...good, cta_text: "" })).toContain("cta_text");
    expect(fields({ ...good, cta_text: "x".repeat(31) })).toContain("cta_text");
    expect(fields({ ...good, body_text: " " })).toContain("body_text");
    expect(fields({ ...good, header_text: "x".repeat(61) })).toContain("header_text");
    expect(fields({ ...good, flow_action: "outra" })).toContain("flow_action");
    expect(fields({ ...good, flow_action: "navigate" })).toContain("screen_id");
    expect(fields({ ...good, next_node_key: "nao_existe" })).toContain("next_node_key");
  });
});
