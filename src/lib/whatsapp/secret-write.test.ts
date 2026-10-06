import { describe, expect, it } from "vitest";
import { decrypt, encrypt, isEncryptedSecret } from "./encryption";
import { isKeepCurrentSecret, resolveSecretForWrite } from "./secret-write";

const MASK = "••••••••••••••••";

function valueOf(result: ReturnType<typeof resolveSecretForWrite>) {
  if (!result.ok) throw new Error("esperava ok");
  return result.value;
}

describe("isKeepCurrentSecret", () => {
  it("vazio, omitido e máscara significam 'manter'", () => {
    expect(isKeepCurrentSecret(undefined)).toBe(true);
    expect(isKeepCurrentSecret(null)).toBe(true);
    expect(isKeepCurrentSecret("")).toBe(true);
    expect(isKeepCurrentSecret("   ")).toBe(true);
    expect(isKeepCurrentSecret(MASK)).toBe(true);
    expect(isKeepCurrentSecret("********")).toBe(true);
  });

  it("um segredo real não é 'manter'", () => {
    expect(isKeepCurrentSecret("0123456789abcdef0123456789abcdef")).toBe(false);
  });
});

describe("resolveSecretForWrite", () => {
  it("valor novo é sempre cifrado no servidor (nunca gravado em texto puro)", () => {
    const value = valueOf(resolveSecretForWrite("  meu-app-secret  ", null));
    expect(value).not.toBe("meu-app-secret");
    expect(isEncryptedSecret(value)).toBe(true);
    expect(decrypt(value!)).toBe("meu-app-secret");
  });

  it("valor novo substitui o atual", () => {
    const existing = encrypt("antigo");
    const value = valueOf(resolveSecretForWrite("novo", existing));
    expect(decrypt(value!)).toBe("novo");
  });

  it("máscara reenviada não sobrescreve o segredo atual", () => {
    const existing = encrypt("segredo-real");
    expect(valueOf(resolveSecretForWrite(MASK, existing))).toBe(existing);
    expect(valueOf(resolveSecretForWrite("", existing))).toBe(existing);
    expect(valueOf(resolveSecretForWrite(undefined, existing))).toBe(existing);
    expect(valueOf(resolveSecretForWrite(null, existing))).toBe(existing);
  });

  it("máscara sem segredo atual resulta em null (não grava a máscara)", () => {
    expect(valueOf(resolveSecretForWrite(MASK, null))).toBeNull();
    expect(valueOf(resolveSecretForWrite(undefined, undefined))).toBeNull();
  });

  it("'manter' com valor atual em texto puro legado cifra no próprio save", () => {
    const value = valueOf(resolveSecretForWrite(undefined, "legado-plain"));
    expect(isEncryptedSecret(value)).toBe(true);
    expect(decrypt(value!)).toBe("legado-plain");
  });

  it("reenviar o próprio ciphertext armazenado não cifra duas vezes", () => {
    const existing = encrypt("segredo");
    expect(valueOf(resolveSecretForWrite(existing, existing))).toBe(existing);
  });

  it("tipo inválido é rejeitado", () => {
    expect(resolveSecretForWrite(12345, null)).toEqual({
      ok: false,
      error: "invalid_type",
    });
  });
});
