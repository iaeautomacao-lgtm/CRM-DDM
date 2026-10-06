import { describe, expect, it } from "vitest";
import { maskSecrets, serializeFlowExport, sortObjectKeys } from "../../../scripts/lib/flow-export.mjs";

describe("exportação versionável de fluxos", () => {
  it("ordena chaves recursivamente e preserva a ordem dos arrays de configuração", () => {
    const input = { z: [{ z: 1, a: { z: 2, a: 3 } }, "primeiro"], a: null };
    const before = JSON.stringify(input);
    expect(JSON.stringify(sortObjectKeys(input))).toBe('{"a":null,"z":[{"a":{"a":3,"z":2},"z":1},"primeiro"]}');
    expect(JSON.stringify(input)).toBe(before);
  });

  it("gera o mesmo JSON para ordens diferentes, sem metadados voláteis", () => {
    const flow = { id: "flow", name: "Cobrança", status: "draft", trigger_type: "manual", trigger_config: { z: 1, a: 2 }, updated_at: "hoje", account_id: "conta" };
    const nodes = [
      { node_key: "z", node_type: "end", config: {}, position_x: 1, position_y: 2, id: "db-id" },
      { node_key: "A", node_type: "start", config: { z: true, a: false }, position_x: 0, position_y: 0 },
    ];
    const result = serializeFlowExport(flow, nodes);
    expect(result).toBe(serializeFlowExport({ ...flow, trigger_config: { a: 2, z: 1 }, updated_at: "amanhã" }, [...nodes].reverse()));
    expect(JSON.parse(result).nodes.map((node: { node_key: string }) => node.node_key)).toEqual(["A", "z"]);
    expect(result).toContain('\n  "flow": {\n');
    expect(result.endsWith("\n")).toBe(true);
    expect(result).not.toMatch(/updated_at|account_id|db-id/);
    expect(nodes[0].node_key).toBe("z");
  });

  it("mascara campos sensíveis, inclusive nested/camelCase/arrays, sem alterar a entrada", () => {
    const input = { accessToken: "short", headers: { Authorization: "Bearer abc", "X-API-Key": "xyz" }, nested: [{ app_secret: "abc", waha_api_key: "xyz", verify_token: "abc", password: 123 }], safe: false };
    const before = JSON.stringify(input);
    expect(maskSecrets(input)).toEqual({ accessToken: "***", headers: { Authorization: "***", "X-API-Key": "***" }, nested: [{ app_secret: "***", waha_api_key: "***", verify_token: "***", password: "***" }], safe: false });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("mascara queries curtas e codificadas, userinfo e tokens em texto livre", () => {
    const input = "https://user:pass@example.com/api?tk=x&cpf={{cpf}}&%74oken=abc&api_key=xyz#fim";
    expect(maskSecrets(input)).toBe("https://***@example.com/api?tk=***&cpf={{cpf}}&%74oken=***&api_key=***#fim");
    expect(maskSecrets("Bearer abc, Basic dXNlcjpwYXNz")).toBe("Bearer ***, Basic ***");
    expect(maskSecrets("Authorization: abc\nX-API-Key: xyz")).toBe("Authorization: ***\nX-API-Key: ***");
    expect(maskSecrets("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature e sk-proj-1234567890123456")).toBe("token *** e ***");
    expect(maskSecrets("https://example.com?token=%broken")).toBe("https://example.com?token=***");
  });

  it("preserva somente referências de segredo, nunca mistura referência e valor real", () => {
    expect(maskSecrets({ api_key: "{{secret.DDM_TOKEN}}", token: "{{secret.X}}real" })).toEqual({ api_key: "{{secret.DDM_TOKEN}}", token: "***" });
    expect(maskSecrets("https://example.com?tk={{secret.DDM_TOKEN}}&key=%7B%7Bsecret.KEY%7D%7D&token={{cpf}}")).toBe("https://example.com?tk={{secret.DDM_TOKEN}}&key=%7B%7Bsecret.KEY%7D%7D&token=***");
    expect(maskSecrets("Bearer {{secret.TOKEN}}")).toBe("Bearer {{secret.TOKEN}}");
    expect(maskSecrets("Bearer {{secret.TOKEN}}real")).toBe("Bearer ***");
  });

  it("mascara valores opacos com formato de token, preservando UUIDs", () => {
    expect(maskSecrets({ custom: "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW", hash: "0123456789abcdef0123456789abcdef" })).toEqual({ custom: "***", hash: "***" });
    expect(maskSecrets("12345678-abcd-1234-abcd-123456789abc")).toBe("12345678-abcd-1234-abcd-123456789abc");
  });

  it("mascara headers em pares nome/valor e segredos no JSON final", () => {
    expect(maskSecrets([{ name: "Authorization", value: "abc" }, { key: "x-api-key", value: "xyz" }, { name: "Accept", value: "application/json" }])).toEqual([{ name: "Authorization", value: "***" }, { key: "x-api-key", value: "***" }, { name: "Accept", value: "application/json" }]);
    const result = serializeFlowExport({ trigger_config: { token: "sensitive-value" } }, [{ node_key: "a", config: { url: "https://example.com?tk=sensitive-value" } }]);
    expect(result).not.toContain("sensitive-value");
    expect(result).toContain("***");
    expect(maskSecrets({ empty: null, count: 2, list: [], enabled: true })).toEqual({ empty: null, count: 2, list: [], enabled: true });
  });
});
