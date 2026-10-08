import { describe, expect, it } from "vitest";
import { findInlineSecrets, isDdmUrl, replaceDdmTokenInText, resolveToolSecrets, sanitizeImportedSecrets } from "./tool-secrets";

const env = { DDM_ACORDOS_API_TOKEN: "abc123SECRET" };

describe("resolveToolSecrets", () => {
  it("troca o marcador pelo token do ambiente no host da DDM", () => {
    const url = "https://www.ddmacordos.com/calc/localiza_dev.php?tk={{secret.DDM_TOKEN}}&cpf=123";
    const r = resolveToolSecrets(url, url, env);
    expect(r.value).toBe("https://www.ddmacordos.com/calc/localiza_dev.php?tk=abc123SECRET&cpf=123");
    expect(r.missing).toEqual([]);
  });

  it("não entrega o token para outro domínio", () => {
    const url = "https://exemplo.com/x?tk={{secret.DDM_TOKEN}}";
    const r = resolveToolSecrets(url, url, env);
    expect(r.value).toBe("https://exemplo.com/x?tk=");
    expect(r.missing).toEqual(["DDM_TOKEN"]);
  });

  it("aponta segredo ausente no ambiente ou nome desconhecido", () => {
    const url = "https://ddmacordos.com/calc/?tk={{secret.DDM_TOKEN}}&x={{secret.OUTRO}}";
    expect(resolveToolSecrets(url, url, {}).missing).toEqual(["DDM_TOKEN", "OUTRO"]);
  });

  it("não mexe em argumentos do modelo", () => {
    const url = "https://ddmacordos.com/calc/?cpf={{cpf}}";
    expect(resolveToolSecrets(url, url, env).value).toBe(url);
  });
});

describe("findInlineSecrets", () => {
  it("acusa token em texto e ignora marcador válido", () => {
    expect(findInlineSecrets("https://ddmacordos.com/calc/?tk=a1b2c3d4e5f6g7h8&cpf={{cpf}}")).toEqual(["tk"]);
    expect(findInlineSecrets("https://ddmacordos.com/calc/?tk={{secret.DDM_TOKEN}}&cpf={{cpf}}")).toEqual([]);
    expect(findInlineSecrets("https://x.com/?page=1")).toEqual([]);
  });

  it("rejeita marcador de segredo com resíduo concatenado", () => {
    const malformed = "https://ddmacordos.com/calc/?tk={{secret.DDM_TOKEN}}" + "RESIDUAL_VALUE_123&cpf={{cpf}}";
    expect(findInlineSecrets(malformed)).toEqual(["tk"]);
  });
});

describe("sanitizeImportedSecrets (TASK25)", () => {
  const ddm = (tk: string) => `https://www.ddmacordos.com/calc/localiza_dev.php?tk=${tk}&cpf={{cpf}}`;
  const aiNode = (url: string, key = "ia") => ({ node_key: key, config: { tools: [{ name: "localizar_devedor", http: { url } }] } });
  const urlOf = (n: { config?: Record<string, unknown> }) => (n.config!.tools as Array<{ http: { url: string } }>)[0].http.url;

  it("troca o token literal pelo marcador", () => {
    const r = sanitizeImportedSecrets([aiNode(ddm("a1b2c3d4e5f6g7h8"))]);
    expect(urlOf(r.nodes[0])).toBe(ddm("{{secret.DDM_TOKEN}}"));
    expect(r.replaced).toBe(1);
    expect(r.rejected).toEqual([]);
  });

  it("token com { e } no meio vai inteiro, sem resíduo colado ao marcador", () => {
    const r = sanitizeImportedSecrets([aiNode(ddm("abc{def}ghi{jkl}mnopq"))]);
    expect(urlOf(r.nodes[0])).toBe(ddm("{{secret.DDM_TOKEN}}"));
    expect(urlOf(r.nodes[0])).not.toContain("mnopq");
  });

  it("para em & e em #; token no fim da URL também", () => {
    expect(replaceDdmTokenInText("https://ddmacordos.com/x?tk=ab{c}d#frag").text).toBe("https://ddmacordos.com/x?tk={{secret.DDM_TOKEN}}#frag");
    expect(replaceDdmTokenInText("https://ddmacordos.com/x?a=1&tk=ab{c}d").text).toBe("https://ddmacordos.com/x?a=1&tk={{secret.DDM_TOKEN}}");
  });

  it("marcador já correto e variável do fluxo ficam como estão", () => {
    const ok = ddm("{{secret.DDM_TOKEN}}");
    expect(replaceDdmTokenInText(ok)).toEqual({ text: ok, replaced: 0 });
    expect(replaceDdmTokenInText(ddm("{{token_var}}")).replaced).toBe(0);
  });

  it("marcador com resíduo colado (estrago da migration 145) é corrigido", () => {
    expect(replaceDdmTokenInText(ddm("{{secret.DDM_TOKEN}}mnopq")).text).toBe(ddm("{{secret.DDM_TOKEN}}"));
  });

  it("não mexe em URL de outro domínio, mas recusa credencial literal nela", () => {
    const r = sanitizeImportedSecrets([aiNode("https://outra-api.com/x?api_key=SEGREDO1234567890", "n2")]);
    expect(urlOf(r.nodes[0])).toContain("SEGREDO1234567890");
    expect(r.rejected).toEqual([{ node_key: "n2", param: "api_key" }]);
  });

  it("http_fetch com URL da DDM também é convertido", () => {
    const r = sanitizeImportedSecrets([{ node_key: "h", config: { url: ddm("zzzzzzzzzzzzzzzz") } }]);
    expect(r.nodes[0].config!.url).toBe(ddm("{{secret.DDM_TOKEN}}"));
  });

  it("isDdmUrl", () => {
    expect(isDdmUrl("https://www.ddmacordos.com/calc/x")).toBe(true);
    expect(isDdmUrl("https://ddmacordos.com.evil.com/x")).toBe(false);
    expect(isDdmUrl("https://exemplo.com/?u=ddmacordos.com")).toBe(false);
  });
});
