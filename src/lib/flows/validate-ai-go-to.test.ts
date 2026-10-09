// Revisão de fluxos (achados do Lume): ai_agent com saída de falha inexistente, ai_agent vinculado a agente sem checagem de next_node_key, go_to para nó que não é âncora.
import { describe, expect, it } from "vitest";

import { reachableFromEntry, validateFlowForActivation } from "./validate";

const flow = { name: "Fluxo", trigger_type: "keyword" as const, trigger_config: { keywords: ["oi"] }, entry_node_id: "start" };
const start = { node_key: "start", node_type: "start", config: { next_node_key: "ia" } };
const fim = { node_key: "fim", node_type: "end", config: {} };
const ho = { node_key: "ho", node_type: "handoff", config: { reason_code: "INDEFINIDO" } };
const ia = (config: Record<string, unknown>) => ({ node_key: "ia", node_type: "ai_agent", config });
const issuesOf = (nodes: unknown[], key = "ia") =>
  validateFlowForActivation(flow, nodes as never).filter((i) => i.node_key === key);

describe("ai_agent — saída de falha (failure_next_node_key)", () => {
  it("aponta para nó inexistente ⇒ erro; para nó real ⇒ sem problema", () => {
    const bad = issuesOf([start, ia({ mode: "once", next_node_key: "fim", failure_next_node_key: "nao_existe" }), fim]);
    expect(bad).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", field: "failure_next_node_key" })]));
    const ok = issuesOf([start, ia({ mode: "once", next_node_key: "fim", failure_next_node_key: "ho" }), fim, ho]);
    expect(ok.filter((i) => i.field === "failure_next_node_key")).toEqual([]);
  });

  it("o destino da falha conta como alcançável (antes aparecia como nó inalcançável)", () => {
    const nodes = [start, ia({ mode: "once", next_node_key: "fim", failure_next_node_key: "ho" }), fim, ho];
    expect(reachableFromEntry("start", nodes as never).has("ho")).toBe(true);
    expect(validateFlowForActivation(flow, nodes as never).some((i) => i.node_key === "ho" && /alcan/i.test(i.message))).toBe(false);
    // takeover não tem saída normal, mas a de falha continua valendo
    expect(reachableFromEntry("start", [start, ia({ mode: "takeover", failure_next_node_key: "ho" }), ho] as never).has("ho")).toBe(true);
  });
});

describe("ai_agent — next_node_key quando o modo vem do agente", () => {
  it("agent_id sem mode: next_node_key inexistente ⇒ erro; ausente ⇒ sem erro (o agente pode ser takeover)", () => {
    const bad = issuesOf([start, ia({ agent_id: "A1", next_node_key: "nao_existe" }), fim]);
    expect(bad).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", field: "next_node_key" })]));
    const semSaida = issuesOf([start, ia({ agent_id: "A1" }), fim]);
    expect(semSaida.filter((i) => i.field === "next_node_key")).toEqual([]);
    const ok = issuesOf([start, ia({ agent_id: "A1", next_node_key: "fim" }), fim]);
    expect(ok.filter((i) => i.field === "next_node_key")).toEqual([]);
  });
});

describe("go_to — destino que não é âncora", () => {
  const goto = (target: string) => ({ node_key: "g", node_type: "go_to", config: { target_node_key: target } });
  const anchor = { node_key: "ancora", node_type: "anchor", config: { label: "Menu", next_node_key: "fim" } };

  it("nó comum como destino ⇒ AVISO (não erro: fluxos antigos continuam ativando); âncora ⇒ nada; inexistente ⇒ erro", () => {
    const comum = issuesOf([{ ...start, config: { next_node_key: "g" } }, goto("fim"), fim], "g");
    expect(comum).toEqual([expect.objectContaining({ severity: "warning", field: "target_node_key" })]);
    expect(issuesOf([{ ...start, config: { next_node_key: "g" } }, goto("ancora"), anchor, fim], "g")).toEqual([]);
    expect(issuesOf([{ ...start, config: { next_node_key: "g" } }, goto("nada"), fim], "g")).toEqual([expect.objectContaining({ severity: "error" })]);
  });
});
