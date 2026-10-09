// Revisão de fluxos (pedido do Lume): a rota do simulador passa a aceitar `operators` (operadores fictícios do painel).
import { describe, expect, it } from "vitest";

import { MAX_SIM_OPERATORS, parseOperators, parseSimulateRequest } from "./parse";

const base = {
  draft: { entry_node_id: "start", trigger_type: "keyword", trigger_config: {}, nodes: [{ node_key: "start", node_type: "start", config: {} }] },
  message: { kind: "text", text: "oi" },
  state: null,
};

describe("parseOperators", () => {
  it("padrões seguros: offline, sem equipe, sem teto; 'online' vence 'away'", () => {
    expect(parseOperators([{ user_id: "u1", name: "Ana" }])).toEqual([{ user_id: "u1", name: "Ana", team_id: null, online: false, away: false, max: null }]);
    expect(parseOperators([{ user_id: "u1", name: "Ana", online: true, away: true, team_id: "T1", max: 3 }])).toEqual([
      { user_id: "u1", name: "Ana", team_id: "T1", online: true, away: false, max: 3 },
    ]);
  });

  it("descarta entrada inválida, repetida e limita a 20; max fora de 1–1000 vira sem teto", () => {
    expect(parseOperators("x")).toEqual([]);
    expect(parseOperators([null, {}, { user_id: "", name: "x" }, { user_id: "u", name: " " }, { user_id: "u", name: "A" }, { user_id: "u", name: "B" }])).toEqual([
      { user_id: "u", name: "A", team_id: null, online: false, away: false, max: null },
    ]);
    expect(parseOperators([{ user_id: "u", name: "A", max: 0 }, { user_id: "v", name: "B", max: 1.5 }, { user_id: "w", name: "C", max: 5000 }]).map((o) => o.max)).toEqual([null, null, null]);
    const many = Array.from({ length: 50 }, (_, i) => ({ user_id: `u${i}`, name: `N${i}` }));
    expect(parseOperators(many)).toHaveLength(MAX_SIM_OPERATORS);
  });

  it("chega ao pedido de simulação (e some do pedido sem o campo)", () => {
    const req = parseSimulateRequest({ ...base, operators: [{ user_id: "u1", name: "Ana", online: true }] });
    if (typeof req === "string") throw new Error(req);
    expect(req.operators).toEqual([{ user_id: "u1", name: "Ana", team_id: null, online: true, away: false, max: null }]);
    const semCampo = parseSimulateRequest(base);
    if (typeof semCampo === "string") throw new Error(semCampo);
    expect(semCampo.operators).toEqual([]);
  });
});
