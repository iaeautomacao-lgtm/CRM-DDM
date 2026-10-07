import { beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/whatsapp/encryption";
import { findAccountSecretRefs, findInlineSecrets, inlineSecretAdvice, resolveToolSecrets } from "./tool-secrets";

// ---------------------------------------------------------------------------
// Variáveis/credenciais da CONTA no resolvedor das ferramentas:
// {{var.X}}, {{cred.X}}, prioridade de {{secret.DDM_TOKEN}} da conta sobre o
// .env, host não permitido, argumentos do modelo, e o carregador (decifra,
// ignora o que não decifra, cache por chamada).
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as { message: string } | null,
  reads: 0,
  accountFilters: [] as unknown[],
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, any> = {};
      b.select = () => b;
      b.eq = (_c: string, v: unknown) => (state.accountFilters.push(v), b);
      b.then = (resolve: (v: unknown) => unknown) => {
        state.reads++;
        return Promise.resolve({ data: state.error ? null : state.rows, error: state.error }).then(resolve);
      };
      return b;
    },
  }),
}));

import { currentAccountSecrets, loadAccountSecrets, withAccountSecretsScope } from "./account-secrets";

const env = { DDM_ACORDOS_API_TOKEN: "env-token-123456" };
const ctx = (
  vars: Record<string, string> = {},
  creds: Record<string, { value: string; hosts: string[] }> = {},
) => ({ vars: new Map(Object.entries(vars)), creds: new Map(Object.entries(creds)) });

describe("resolveToolSecrets — variáveis e credenciais da conta", () => {
  it("{{var.X}} vem da conta SEM encode (pode montar a URL base); ausente vira vazio + missing", () => {
    const account = ctx({ BASE_PATH: "a b/c" });
    const url = "https://api.exemplo.com/{{var.BASE_PATH}}?q={{var.NAO_EXISTE}}";
    const r = resolveToolSecrets(url, url, {}, { encode: true, account });
    expect(r.value).toBe("https://api.exemplo.com/a b/c?q=");
    expect(r.missing).toEqual(["var.NAO_EXISTE"]);
  });

  it("{{cred.X}} só vai para host permitido (e subdomínios)", () => {
    const account = ctx({}, { API_KEY: { value: "segredo-123", hosts: ["exemplo.com"] } });
    const ok = "https://api.exemplo.com/x?k={{cred.API_KEY}}";
    expect(resolveToolSecrets(ok, ok, {}, { account })).toEqual({ value: "https://api.exemplo.com/x?k=segredo-123", missing: [], usedSecrets: true });
    const bad = "https://evil.com/x?k={{cred.API_KEY}}";
    const r = resolveToolSecrets(bad, bad, {}, { account });
    expect(r.value).toBe("https://evil.com/x?k=");
    expect(r.missing).toEqual(["cred.API_KEY"]);
    // sufixo enganoso não passa
    const trick = "https://notexemplo.com/x?k={{cred.API_KEY}}";
    expect(resolveToolSecrets(trick, trick, {}, { account }).missing).toEqual(["cred.API_KEY"]);
  });

  it("credencial inexistente na conta (ou sem contexto de conta) → missing", () => {
    const url = "https://api.exemplo.com/?k={{cred.NADA}}";
    expect(resolveToolSecrets(url, url, {}, { account: ctx() }).missing).toEqual(["cred.NADA"]);
    expect(resolveToolSecrets(url, url, {}).missing).toEqual(["cred.NADA"]);
  });

  it("host montado por variável ({{var.HOST}}) vale para a checagem da credencial", () => {
    const account = ctx({ HOST: "api.exemplo.com" }, { API_KEY: { value: "k1", hosts: ["exemplo.com"] } });
    const url = "https://{{var.HOST}}/x?k={{cred.API_KEY}}";
    expect(resolveToolSecrets(url, url, {}, { account }).value).toBe("https://api.exemplo.com/x?k=k1");
  });

  it("headers/body: sem encode", () => {
    const account = ctx({}, { T: { value: "a b&c", hosts: ["exemplo.com"] } });
    const url = "https://exemplo.com/x";
    expect(resolveToolSecrets("Bearer {{cred.T}}", url, {}, { account }).value).toBe("Bearer a b&c");
  });

  describe("{{secret.DDM_TOKEN}}: compatibilidade e prioridade", () => {
    const url = "https://www.ddmacordos.com/calc/?tk={{secret.DDM_TOKEN}}";
    it("sem credencial da conta, continua vindo do .env", () => {
      expect(resolveToolSecrets(url, url, env, { account: ctx() }).value).toBe("https://www.ddmacordos.com/calc/?tk=env-token-123456");
    });
    it("credencial DDM_TOKEN da conta tem prioridade sobre o .env", () => {
      const account = ctx({}, { DDM_TOKEN: { value: "token-da-conta", hosts: ["ddmacordos.com"] } });
      expect(resolveToolSecrets(url, url, env, { account }).value).toBe("https://www.ddmacordos.com/calc/?tk=token-da-conta");
    });
    it("credencial da conta com host diferente NÃO cai no .env: missing", () => {
      const account = ctx({}, { DDM_TOKEN: { value: "token-da-conta", hosts: ["outro.com"] } });
      const r = resolveToolSecrets(url, url, env, { account });
      expect(r.value).toBe("https://www.ddmacordos.com/calc/?tk=");
      expect(r.missing).toEqual(["DDM_TOKEN"]);
    });
  });

  it("argumento do modelo com {{cred.X}} nunca vira segredo (segredos resolvem ANTES dos argumentos)", () => {
    const account = ctx({}, { API_KEY: { value: "segredo-123", hosts: ["exemplo.com"] } });
    const template = "https://api.exemplo.com/busca?q={{termo}}&k={{cred.API_KEY}}";
    const resolved = resolveToolSecrets(template, template, {}, { account }).value;
    // Mesmo passo do responder: interpolação dos argumentos DEPOIS dos segredos.
    const interpolate = (str: string, args: Record<string, string>) =>
      str.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => args[key] ?? "");
    const final = interpolate(resolved, { termo: "{{cred.API_KEY}} {{secret.DDM_TOKEN}}" });
    expect(final).toBe("https://api.exemplo.com/busca?q={{cred.API_KEY}} {{secret.DDM_TOKEN}}&k=segredo-123");
    expect(final.match(/segredo-123/g)).toHaveLength(1); // só o k=, nunca duplicado via argumento
  });

  it("mask: o valor da credencial nunca é lido — vira ***; as regras de host continuam valendo", () => {
    const account = ctx({}, { API_KEY: { value: "segredo-123", hosts: ["exemplo.com"] } });
    const ok = "https://api.exemplo.com/x?k={{cred.API_KEY}}";
    const masked = resolveToolSecrets(ok, ok, {}, { account, mask: true });
    expect(masked).toEqual({ value: "https://api.exemplo.com/x?k=***", missing: [], usedSecrets: true });
    const bad = "https://evil.com/x?k={{cred.API_KEY}}";
    expect(resolveToolSecrets(bad, bad, {}, { account, mask: true })).toMatchObject({ value: "https://evil.com/x?k=", missing: ["cred.API_KEY"] });
    // secret.DDM_TOKEN do ambiente também fica mascarado.
    const ddm = "https://www.ddmacordos.com/c?tk={{secret.DDM_TOKEN}}";
    expect(resolveToolSecrets(ddm, ddm, { DDM_ACORDOS_API_TOKEN: "env-token-123456" }, { mask: true }).value).toBe("https://www.ddmacordos.com/c?tk=***");
  });

  it("valor de variável com marcador não é reexpandido", () => {
    const account = ctx({ A: "{{cred.B}}" }, { B: { value: "s", hosts: ["exemplo.com"] } });
    const url = "https://exemplo.com/{{var.A}}";
    expect(resolveToolSecrets(url, url, {}, { account }).value).toBe("https://exemplo.com/{{cred.B}}");
  });
});

describe("validador: marcadores e mensagem", () => {
  it("findInlineSecrets aceita {{cred.X}} e {{var.X}} como valor do parâmetro", () => {
    expect(findInlineSecrets("https://x.com/?tk={{cred.DDM_TOKEN}}")).toEqual([]);
    expect(findInlineSecrets("https://x.com/?key={{var.CHAVE_PUBLICA}}")).toEqual([]);
    expect(findInlineSecrets("https://x.com/?tk=a1b2c3d4e5f6g7h8")).toEqual(["tk"]);
  });
  it("mensagem sugere cadastrar em Configurações → Variáveis e credenciais e usar {{cred.NOME}}", () => {
    const msg = inlineSecretAdvice("buscar", ["tk"]);
    expect(msg).toContain("Configurações → Variáveis e credenciais");
    expect(msg).toContain("{{cred.NOME}}");
  });
  it("findAccountSecretRefs lê url, headers e body", () => {
    expect(
      findAccountSecretRefs(["https://x.com/{{var.A}}?k={{cred.K}}", "Bearer {{cred.T}}", '{"a":"{{var.B}}","t":"{{secret.DDM_TOKEN}}"}']),
    ).toEqual({ creds: ["K", "T"], vars: ["A", "B"] });
  });
});

describe("loadAccountSecrets", () => {
  beforeEach(() => {
    state.rows = [];
    state.error = null;
    state.reads = 0;
    state.accountFilters = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("decifra credenciais, lê variáveis e filtra pela conta", async () => {
    state.rows = [
      { name: "BASE_URL", kind: "variable", value_plain: "https://a.com", value_encrypted: null, allowed_hosts: null },
      { name: "TOKEN", kind: "credential", value_plain: null, value_encrypted: encrypt("tok-real"), allowed_hosts: ["A.com"] },
    ];
    const c = await loadAccountSecrets("ACC-9");
    expect(c.vars.get("BASE_URL")).toBe("https://a.com");
    expect(c.creds.get("TOKEN")).toEqual({ value: "tok-real", hosts: ["a.com"] });
    expect(state.accountFilters).toEqual(["ACC-9"]);
  });

  it("credencial que não decifra é ignorada (vira ausente), sem derrubar as demais", async () => {
    state.rows = [
      { name: "RUIM", kind: "credential", value_plain: null, value_encrypted: "aaaaaaaaaaaaaaaaaaaaaaaa:bbbb:cccc", allowed_hosts: ["a.com"] },
      { name: "SEM_HOST", kind: "credential", value_plain: null, value_encrypted: encrypt("x"), allowed_hosts: [] },
      { name: "BOA", kind: "credential", value_plain: null, value_encrypted: encrypt("ok"), allowed_hosts: ["a.com"] },
    ];
    const c = await loadAccountSecrets("ACC-9");
    expect([...c.creds.keys()]).toEqual(["BOA"]);
  });

  it("falha de leitura devolve vazio (cai no ambiente) e não vaza detalhe no log", async () => {
    state.error = { message: "conexão recusada" };
    const c = await loadAccountSecrets("ACC-9");
    expect(c.vars.size + c.creds.size).toBe(0);
  });

  it("escopo por conta: fora do escopo devolve null; dentro, carrega a cada chamada (sem cache de processo)", async () => {
    expect(await currentAccountSecrets()).toBeNull();
    state.rows = [{ name: "V", kind: "variable", value_plain: "1", value_encrypted: null, allowed_hosts: null }];
    await withAccountSecretsScope("ACC-1", async () => {
      expect((await currentAccountSecrets())?.vars.get("V")).toBe("1");
      state.rows = [{ name: "V", kind: "variable", value_plain: "2", value_encrypted: null, allowed_hosts: null }];
      expect((await currentAccountSecrets())?.vars.get("V")).toBe("2"); // trocou → vale na hora
    });
    expect(state.reads).toBe(2);
  });
});
