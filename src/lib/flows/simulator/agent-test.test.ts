// Testar agente (TASK1-C): fluxo sintético e resumo da linha do tempo para o painel.
import { describe, expect, it } from "vitest";

import { AGENT_TEST_NODE_KEY, AGENT_TEST_RESULT_CHARS, buildAgentTestFlow, maskAgentTestRun, summarizeAgentTestTimeline } from "./agent-test";
import { parseSimulateRequest } from "./parse";
import { SIM_NEVER_REAL_TOOLS, SIM_READ_ONLY_TOOLS } from "./types";
import { isEffectfulTool } from "@/lib/ai/tool-recovery";

const AGENT = "22222222-2222-4222-8222-222222222222";

describe("buildAgentTestFlow", () => {
  it("início → um nó ai_agent ligado ao agente, aceito pelo parser do simulador", () => {
    const flow = buildAgentTestFlow(AGENT);
    expect(flow.nodes).toEqual([
      { node_key: "inicio", node_type: "start", config: { next_node_key: AGENT_TEST_NODE_KEY } },
      { node_key: AGENT_TEST_NODE_KEY, node_type: "ai_agent", config: { agent_id: AGENT } },
    ]);
    const parsed = parseSimulateRequest({ draft: flow, message: { kind: "text", text: "oi" } });
    expect(typeof parsed).not.toBe("string");
  });
});

describe("summarizeAgentTestTimeline", () => {
  const at = "2026-10-09T12:00:00.000Z";

  it("mascara CPF nos argumentos, nos rótulos e no resultado, e resume o resultado", () => {
    const longo = `{"cpf":"52998224725","dados":"${"x".repeat(2000)}"}`;
    const out = summarizeAgentTestTimeline([
      { at, type: "tool_call", node_key: "agente", label: "Tool chamada: localizar_devedor", detail: { cpf: "52998224725", nome: "Maria" } },
      { at, type: "tool_result", node_key: "agente", label: "Resultado de localizar_devedor", detail: longo },
      { at, type: "note", node_key: null, label: "CPF 529.982.247-25 informado" },
    ]);
    expect(out[0].detail).toEqual({ cpf: "***.***.***-25", nome: "Maria" });
    expect(String(out[1].detail)).not.toContain("52998224725");
    expect(String(out[1].detail).length).toBeLessThanOrEqual(AGENT_TEST_RESULT_CHARS + 1);
    expect(out[2].label).toBe("CPF ***.***.***-25 informado");
  });

  it("variáveis do run saem sem CPF", () => {
    const run = maskAgentTestRun({ id: "r", status: "active", current_node_key: "agente", vars: { cpf: "529.982.247-25" }, end_reason: null });
    expect(run?.vars).toEqual({ cpf: "***.***.***-25" });
    expect(maskAgentTestRun(null)).toBeNull();
  });
});

describe("política de ferramentas do teste = a do responder", () => {
  it("só as somente-leitura do simulador são consulta pura para o responder; efetiva_acordo (GET) tem efeito", () => {
    for (const name of SIM_READ_ONLY_TOOLS) {
      expect(isEffectfulTool([{ name, http: { method: "GET" } }], name), name).toBe(false);
    }
    for (const name of SIM_NEVER_REAL_TOOLS) {
      expect(isEffectfulTool([{ name, http: { method: "GET" } }], name), name).toBe(true);
    }
  });
});
