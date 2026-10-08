import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";

const flow = { name: "Fluxo", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "n1" };
const tools = [
  { id: "t-on", name: "buscar_cpf", enabled: true },
  { id: "t-off", name: "enviar_boleto", enabled: false },
];

function issues(config: Record<string, unknown>, aiTools: typeof tools | null | undefined = tools) {
  return validateFlowForActivation(flow, [{ node_key: "n1", node_type: "ai_agent", config }], { aiTools }).filter(
    (i) => i.field === "tool_refs" || i.field === "tools",
  );
}

describe("validador de fluxo — tool_refs (catálogo)", () => {
  it("referência inexistente ou de outra conta é ERRO (bloqueia a ativação)", () => {
    const r = issues({ tool_refs: ["t-on", "id-de-outra-conta"] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ severity: "error", field: "tool_refs" });
  });

  it("ferramenta desligada é AVISO", () => {
    const r = issues({ tool_refs: ["t-off"] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ severity: "warning" });
    expect(r[0].message).toContain("enviar_boleto");
    expect(r[0].message).toContain("desligada");
  });

  it("referências válidas e ligadas: sem problema", () => {
    expect(issues({ tool_refs: ["t-on"] })).toEqual([]);
  });

  it("nome repetido entre catálogo e inline é ERRO", () => {
    const r = issues({
      tool_refs: ["t-on"],
      tools: [{ name: "buscar_cpf", description: "d", parameters: { type: "object", properties: {} }, http: { url: "https://a.com/x", method: "GET" } }],
    });
    expect(r.some((i) => i.severity === "error" && i.message.includes("buscar_cpf"))).toBe(true);
  });

  it("sem a lista do catálogo (falha de leitura/editor): não acusa nada; nó sem tool_refs não muda", () => {
    expect(issues({ tool_refs: ["qualquer"] }, null)).toEqual([]);
    // Sem contexto nenhum (chamadores antigos): idem.
    const noContext = validateFlowForActivation(flow, [{ node_key: "n1", node_type: "ai_agent", config: { tool_refs: ["qualquer"] } }]);
    expect(noContext.filter((i) => i.field === "tool_refs")).toEqual([]);
    expect(issues({})).toEqual([]);
  });
});
