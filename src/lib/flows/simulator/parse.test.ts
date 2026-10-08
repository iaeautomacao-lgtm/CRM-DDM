import { describe, expect, it } from "vitest";
import { parseSimulateRequest } from "./parse";

const base = {
  draft: { entry_node_id: "start", trigger_type: "keyword", trigger_config: {}, nodes: [{ node_key: "start", node_type: "start", config: {} }] },
  message: { kind: "text", text: "oi" },
  state: null,
};

describe("parseSimulateRequest", () => {
  it("aplica padrões seguros", () => {
    const req = parseSimulateRequest(base);
    expect(typeof req).toBe("object");
    if (typeof req === "string") return;
    expect(req.provider).toBe("meta");
    expect(req.ignoreTrigger).toBe(true);
    expect(req.realReadOnlyTools).toEqual([]);
    expect(req.contact.name).toBe("Cliente Teste");
  });

  it("rejeita mensagem vazia e nó inválido", () => {
    expect(parseSimulateRequest({ ...base, message: { kind: "text", text: "  " } })).toBe("Mensagem vazia");
    expect(parseSimulateRequest({ ...base, draft: { ...base.draft, nodes: [{ node_key: 1 }] } })).toBe("Nó inválido no rascunho");
  });

  it("estado: só as tabelas da simulação passam", () => {
    const req = parseSimulateRequest({
      ...base,
      state: { version: 1, clock: 5, seq: 2, tables: { flow_runs: [{ id: "r" }], ai_config: [{ api_key: "x" }] } },
    });
    if (typeof req === "string") throw new Error(req);
    expect(req.state?.tables.flow_runs).toEqual([{ id: "r" }]);
    expect(Object.keys(req.state?.tables ?? {})).not.toContain("ai_config");
  });
});
