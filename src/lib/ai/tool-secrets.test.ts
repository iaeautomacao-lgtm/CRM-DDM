import { describe, expect, it } from "vitest";
import { findInlineSecrets, hostCheckUrl, resolveToolSecrets } from "./tool-secrets";

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

describe("credencial: https, porta e variável de URL base (REVISAO-113 #4/#5)", () => {
  const account = {
    vars: new Map([["BASE", "https://api.exemplo.com"]]),
    creds: new Map([["TOK", { value: "tok-1234567890", hosts: ["exemplo.com"] }]]),
  };
  const resolve = (url: string, final = url) => resolveToolSecrets(url, final, {}, { account });

  it("não entrega credencial por http:// nem em porta diferente de 443", () => {
    expect(resolve("http://api.exemplo.com/x?k={{cred.TOK}}").missing).toEqual(["cred.TOK"]);
    expect(resolve("https://api.exemplo.com:8443/x?k={{cred.TOK}}").missing).toEqual(["cred.TOK"]);
    expect(resolve("https://api.exemplo.com:443/x?k={{cred.TOK}}").missing).toEqual([]);
  });

  it("host parecido, @ e maiúsculas continuam tratados", () => {
    expect(resolve("https://exemplo.com.evil.com/x?k={{cred.TOK}}").missing).toEqual(["cred.TOK"]);
    expect(resolve("https://exemplo.com@evil.com/x?k={{cred.TOK}}").missing).toEqual(["cred.TOK"]);
    expect(resolve("https://API.EXEMPLO.COM/x?k={{cred.TOK}}").missing).toEqual([]);
  });

  it("{{var.BASE}}/x: variável não é codificada e o host checado é o da URL enviada", () => {
    const template = "{{var.BASE}}/x?k={{cred.TOK}}";
    const destination = hostCheckUrl(template, account);
    const r = resolveToolSecrets(template, destination, {}, { account, encode: true });
    expect(r.value).toBe("https://api.exemplo.com/x?k=tok-1234567890");
    expect(r.missing).toEqual([]);
    // O host que decidiu é o mesmo da URL final (sem a credencial).
    expect(new URL(r.value).hostname).toBe(new URL(destination).hostname);
  });

  it("variável com host de fora não recebe credencial", () => {
    const evil = { ...account, vars: new Map([["BASE", "https://evil.com"]]) };
    const template = "{{var.BASE}}/x?k={{cred.TOK}}";
    const r = resolveToolSecrets(template, hostCheckUrl(template, evil), {}, { account: evil, encode: true });
    expect(r.missing).toEqual(["cred.TOK"]);
    expect(r.value).not.toContain("tok-1234567890");
  });
});
