import { describe, expect, it } from "vitest";
import { findInlineSecrets, resolveToolSecrets } from "./tool-secrets";

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
