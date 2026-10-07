import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";

const flow = {
  name: "Fluxo",
  trigger_type: "manual" as const,
  trigger_config: {},
  entry_node_id: "n1",
};

function toolIssues(
  http: { url: string; body?: string; headers?: Record<string, string> },
  accountSecrets?: { credentials: string[]; variables: string[] } | null,
) {
  const nodes = [
    {
      node_key: "n1",
      node_type: "ai_agent",
      config: {
        tools: [{ name: "buscar", description: "d", parameters: { type: "object", properties: {} }, http: { method: "GET", ...http } }],
      },
    },
  ];
  return validateFlowForActivation(flow, nodes, { accountSecrets }).filter((i) => i.field === "tools");
}

describe("validador de fluxo — variáveis e credenciais da conta", () => {
  it("token em texto na URL: aviso manda cadastrar em Variáveis e credenciais e usar {{cred.NOME}}", () => {
    const issues = toolIssues({ url: "https://api.exemplo.com/x?tk=a1b2c3d4e5f6g7h8" });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("Configurações → Variáveis e credenciais");
    expect(issues[0].message).toContain("{{cred.NOME}}");
  });

  it("{{cred.X}} inexistente na conta → aviso (url, headers e body)", () => {
    const issues = toolIssues(
      { url: "https://api.exemplo.com/x?tk={{cred.FALTA_A}}", headers: { Authorization: "Bearer {{cred.FALTA_B}}" }, body: '{"b":"{{var.FALTA_C}}"}' },
      { credentials: ["OUTRA"], variables: [] },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("{{cred.FALTA_A}}");
    expect(issues[0].message).toContain("{{cred.FALTA_B}}");
    expect(issues[0].message).toContain("{{var.FALTA_C}}");
  });

  it("marcadores que existem na conta não geram aviso; sem lista de nomes (null), não confere", () => {
    const http = { url: "https://api.exemplo.com/{{var.BASE}}?tk={{cred.TOKEN}}" };
    expect(toolIssues(http, { credentials: ["TOKEN"], variables: ["BASE"] })).toEqual([]);
    expect(toolIssues(http, null)).toEqual([]);
    expect(toolIssues(http)).toEqual([]);
  });
});
