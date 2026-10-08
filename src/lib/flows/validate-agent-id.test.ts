import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";

const flow = { name: "Fluxo", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "n1" };
const agents = [
  { id: "on", name: "Cobrança", enabled: true },
  { id: "off", name: "Antigo", enabled: false },
];
const run = (agent_id: string) =>
  validateFlowForActivation(flow, [{ node_key: "n1", node_type: "ai_agent", config: { agent_id } }], { agents }).filter(
    (i) => i.field === "agent_id",
  );

describe("validador de fluxo — agent_id", () => {
  it("inexistente/outra conta é ERRO", () => {
    expect(run("outra-conta")).toMatchObject([{ severity: "error" }]);
  });
  it("desligado é AVISO", () => {
    const r = run("off");
    expect(r).toMatchObject([{ severity: "warning" }]);
    expect(r[0].message).toContain("Antigo");
  });
  it("ligado: sem problema", () => {
    expect(run("on")).toEqual([]);
  });
});
