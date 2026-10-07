import { describe, expect, it } from "vitest";
import { findLiteralCredential, toolHost, toolTimeoutMs, unknownSecretRefs, validateToolInput } from "./tool-input";
import { buildToolRequest, exampleArguments, sanitizeResponseBody } from "./tool-request";

const base = (over: Record<string, unknown> = {}) => ({
  name: "buscar_cpf",
  description: "Consulta o CPF do cliente",
  parameters: { type: "object", properties: { cpf: { type: "string", description: "cpf" } }, required: ["cpf"] },
  http: { url: "https://api.exemplo.com/cpf?cpf={{cpf}}", method: "GET" },
  ...over,
});

describe("validateToolInput", () => {
  it("aceita uma ferramenta válida e normaliza (display_name = name, timeout 30000, ligada)", () => {
    const r = validateToolInput(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ name: "buscar_cpf", display_name: "buscar_cpf", timeout_ms: 30000, enabled: true });
      expect(r.value.http).toEqual({ url: "https://api.exemplo.com/cpf?cpf={{cpf}}", method: "GET" });
    }
  });

  it("nome da função: ^[a-z][a-z0-9_]{1,63}$", () => {
    for (const bad of ["Buscar", "1abc", "a", "com-hifen", "com espaco", "x".repeat(65)]) {
      expect(validateToolInput(base({ name: bad })).ok).toBe(false);
    }
  });

  it("URL precisa ser https", () => {
    expect(validateToolInput(base({ http: { url: "http://api.exemplo.com/x", method: "GET" } })).ok).toBe(false);
    expect(validateToolInput(base({ http: { url: "ftp://x.com", method: "GET" } })).ok).toBe(false);
    expect(validateToolInput(base({ http: { url: "https://{{var.BASE}}/x", method: "GET" } })).ok).toBe(true);
  });

  describe("credencial literal é recusada (usar {{cred.NOME}})", () => {
    const reject = (http: Record<string, unknown>) => {
      const r = validateToolInput(base({ http: { method: "POST", ...http } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("{{cred.NOME}}");
    };
    it("token na URL", () => reject({ url: "https://api.exemplo.com/x?tk=a1b2c3d4e5f6g7h8" }));
    it("usuário:senha na URL", () => reject({ url: "https://usuario:senha@api.exemplo.com/x" }));
    it("Authorization com valor literal", () => reject({ url: "https://api.exemplo.com/x", headers: { Authorization: "Bearer abcdef123456" } }));
    it("x-api-key com valor literal", () => reject({ url: "https://api.exemplo.com/x", headers: { "X-API-Key": "abcdef123456" } }));
    it("campo de credencial no body com valor fixo", () => reject({ url: "https://api.exemplo.com/x", body: '{"token":"abcdef123456","cpf":"{{cpf}}"}' }));

    it("marcadores são aceitos (Bearer {{cred.X}}, x-api-key {{cred.X}}, body com {{cred.X}} e {{param}})", () => {
      const ok = validateToolInput(
        base({
          http: {
            url: "https://api.exemplo.com/x?tk={{cred.DDM_TOKEN}}",
            method: "POST",
            headers: { Authorization: "Bearer {{cred.API}}", "X-API-Key": "{{secret.DDM_TOKEN}}", Accept: "application/json" },
            body: '{"api_key":"{{cred.API}}","token":"{{tok}}","cpf":"{{cpf}}"}',
          },
        })
      );
      expect(ok.ok).toBe(true);
    });

    it("findLiteralCredential direto", () => {
      expect(findLiteralCredential({ url: "https://x.com/?page=1" })).toBeNull();
      expect(findLiteralCredential({ url: "https://x.com/", headers: { Cookie: "sid=abc" } })).toMatch(/Cookie/);
    });
  });

  it("parâmetros: nomes, tipos, limites e required coerente", () => {
    expect(validateToolInput(base({ parameters: { type: "object", properties: { "com.ponto": { type: "string" } } } })).ok).toBe(false);
    expect(validateToolInput(base({ parameters: { type: "object", properties: { a: { type: "objeto" } } } })).ok).toBe(false);
    expect(validateToolInput(base({ parameters: { type: "object", properties: { a: { type: "string" } }, required: ["b"] } })).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, { type: "string" }]));
    expect(validateToolInput(base({ parameters: { type: "object", properties: many } })).ok).toBe(false);
  });

  it("timeout 1.000–60.000; descrição obrigatória; método inválido", () => {
    expect(validateToolInput(base({ timeout_ms: 500 })).ok).toBe(false);
    expect(validateToolInput(base({ timeout_ms: 90000 })).ok).toBe(false);
    expect(validateToolInput(base({ timeout_ms: 5000 })).ok).toBe(true);
    expect(validateToolInput(base({ description: "  " })).ok).toBe(false);
    expect(validateToolInput(base({ http: { url: "https://a.com/x", method: "TRACE" } })).ok).toBe(false);
  });

  it("body só vale para POST/PUT/PATCH", () => {
    const get = validateToolInput(base({ http: { url: "https://a.com/x", method: "GET", body: "{}" } }));
    if (get.ok) expect(get.value.http.body).toBeUndefined();
    const post = validateToolInput(base({ http: { url: "https://a.com/x", method: "POST", body: '{"a":1}' } }));
    if (post.ok) expect(post.value.http.body).toBe('{"a":1}');
  });
});

describe("unknownSecretRefs / toolHost / toolTimeoutMs", () => {
  it("aponta cred/var que não existem na conta", () => {
    const http = { url: "https://{{var.BASE}}/x", headers: { A: "Bearer {{cred.K}}" }, body: '{"v":"{{var.Y}}"}' };
    expect(unknownSecretRefs(http, { credentials: ["K"], variables: ["BASE"] })).toEqual(["{{var.Y}}"]);
    expect(unknownSecretRefs(http, { credentials: [], variables: [] }).sort()).toEqual(["{{cred.K}}", "{{var.BASE}}", "{{var.Y}}"].sort());
  });
  it("host do template e timeout", () => {
    expect(toolHost("https://api.exemplo.com/x?q={{a}}")).toBe("api.exemplo.com");
    expect(toolHost("https://{{var.BASE}}/x")).toBe("x");
    expect(toolTimeoutMs(undefined)).toBe(30000);
    expect(toolTimeoutMs(10)).toBe(1000);
    expect(toolTimeoutMs(1e9)).toBe(60000);
  });
});

describe("buildToolRequest / sanitizeResponseBody", () => {
  const account = {
    vars: new Map([["BASE", "api.exemplo.com"]]),
    creds: new Map([["API", { value: "SEGREDO-ABCDEF", hosts: ["exemplo.com"] }]]),
  };
  it("monta a requisição na ordem do agente e marca credencial usada", () => {
    const r = buildToolRequest(
      { http: { url: "https://{{var.BASE}}/c?cpf={{cpf}}", method: "GET", headers: { Authorization: "Bearer {{cred.API}}" } } },
      { cpf: "123" },
      account,
    );
    expect(r.url).toBe("https://api.exemplo.com/c?cpf=123");
    expect(r.headers.Authorization).toBe("Bearer SEGREDO-ABCDEF");
    expect(r.credentialInjected).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it("host final (por argumento) fora da lista: credencial não sai e vira missing", () => {
    const r = buildToolRequest({ http: { url: "https://{{h}}/c", method: "GET", headers: { Authorization: "Bearer {{cred.API}}" } } }, { h: "evil.com" }, account);
    expect(r.headers.Authorization).toBe("Bearer ");
    expect(r.missing).toEqual(["cred.API"]);
    expect(r.credentialInjected).toBe(false);
  });
  it("sanitiza o corpo: valores de credenciais viram *** (inclusive codificados) e corta em 2 KB", () => {
    const text = `ecoou SEGREDO-ABCDEF e ${encodeURIComponent("SEGREDO ABCDEF")} fim`;
    expect(sanitizeResponseBody(text, ["SEGREDO-ABCDEF", "SEGREDO ABCDEF"])).toBe("ecoou *** e *** fim");
    expect(sanitizeResponseBody("x".repeat(5000), [])).toHaveLength(2048 + "…[truncado]".length);
  });
  it("exampleArguments por tipo", () => {
    expect(exampleArguments({ type: "object", properties: { a: { type: "string", description: "" }, n: { type: "number", description: "" }, b: { type: "boolean", description: "" }, e: { type: "string", description: "", enum: ["x", "y"] } } })).toEqual({ a: "exemplo", n: 1, b: true, e: "x" });
  });
});
