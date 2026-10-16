import { describe, expect, it } from "vitest";
import { mentionAliasErrorMessage, parseMentionAlias } from "./mention-alias";

describe("parseMentionAlias", () => {
  it("normaliza @, espaços e maiúsculas", () => {
    expect(parseMentionAlias("  @Adriana ")).toEqual({ ok: true, alias: "adriana" });
  });

  it("vazio remove o apelido", () => {
    expect(parseMentionAlias("")).toEqual({ ok: true, alias: null });
    expect(parseMentionAlias(" @ ")).toEqual({ ok: true, alias: null });
  });

  it("aceita _ e números depois da primeira letra, 2 a 32 caracteres", () => {
    expect(parseMentionAlias("_a1").ok).toBe(true);
    expect(parseMentionAlias("ab").ok).toBe(true);
    expect(parseMentionAlias("a".repeat(32)).ok).toBe(true);
  });

  it("rejeita o que o servidor rejeita", () => {
    for (const bad of ["a", "a".repeat(33), "1abc", "açai", "ana maria", "ana-maria", "@@ana"]) {
      expect(parseMentionAlias(bad).ok, bad).toBe(false);
    }
  });
});

describe("mentionAliasErrorMessage", () => {
  it("409 vira apelido em uso", () => {
    expect(mentionAliasErrorMessage(409, "Alias já está em uso nesta conta")).toMatch(/em uso/);
  });

  it("usa a mensagem do servidor nos demais casos, com padrão", () => {
    expect(mentionAliasErrorMessage(400, "Usuário não é operador desta conta")).toBe("Usuário não é operador desta conta");
    expect(mentionAliasErrorMessage(500)).toMatch(/Não foi possível/);
  });
});
