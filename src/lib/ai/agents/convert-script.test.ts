/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import * as convert from "@/lib/ai/agents/convert";
import { planConversion } from "../../../../scripts/convert-ai-nodes-to-agents.mjs";

const account = { account_id: "11111111-1111-4111-8111-111111111111", enabled: true, api_provider: "openai", api_model: "gpt-4o-mini" };
const base = {
  accounts: new Map([["11111111-1111-4111-8111-111111111111", account]]),
  flows: [
    { id: "f1", name: "Fluxo 1", account_id: "11111111-1111-4111-8111-111111111111" },
    { id: "f2", name: "Fluxo 2", account_id: "11111111-1111-4111-8111-111111111111" },
    { id: "f3", name: "Ativo", account_id: "11111111-1111-4111-8111-111111111111" },
  ],
  nodes: [
    { id: "n1", flow_id: "f1", node_key: "ai", config: { mode: "loop", max_turns: 3 } },
    { id: "n2", flow_id: "f2", node_key: "ai", config: { mode: "loop", max_turns: 3 } },
    { id: "n3", flow_id: "f3", node_key: "ai", config: { mode: "loop" } },
    { id: "n4", flow_id: "f1", node_key: "ja", config: { agent_id: "x" } },
  ],
  activeFlowIds: new Set(["f3"]),
  kb: new Map(),
};

describe("convert-ai-nodes-to-agents (dry-run/plano)", () => {
  it("dedupe por hash, pula fluxo com runs ativos e ignora nó já vinculado", () => {
    const plan = (planConversion as any)(base, convert);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].nodes.map((n: { flow_id: string }) => n.flow_id).sort()).toEqual(["f1", "f2"]);
    expect(plan.skipped.map((s: { flow_id: string }) => s.flow_id)).toEqual(["f3"]);
  });
  it("credencial literal não converte e o relatório não vaza o segredo", () => {
    const plan = (planConversion as any)({ ...base, accounts: new Map([["11111111-1111-4111-8111-111111111111", { ...account, api_key: "sk-SEGREDO-123" }]]) }, convert);
    expect(plan.items).toHaveLength(0);
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan.errors)).not.toContain("sk-SEGREDO-123");
  });
});
