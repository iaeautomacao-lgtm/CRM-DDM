import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, translateAuthError } from "./auth-errors";

describe("translateAuthError", () => {
  it("traduz mensagens comuns do Supabase", () => {
    expect(translateAuthError({ message: "Invalid login credentials" })).toBe(
      "E-mail ou senha incorretos.",
    );
    expect(translateAuthError({ message: "Email not confirmed" })).toMatch(/Confirme seu e-mail/);
    expect(translateAuthError({ message: "User already registered" })).toMatch(/Já existe/);
    expect(
      translateAuthError({ message: "Password should be at least 6 characters." }),
    ).toContain(String(MIN_PASSWORD_LENGTH));
    expect(translateAuthError({ message: "Email rate limit exceeded" })).toMatch(/Muitas tentativas/);
    expect(translateAuthError({ message: "Token has expired or is invalid" })).toMatch(/expirou/);
    expect(translateAuthError(new TypeError("Failed to fetch"))).toMatch(/conexão/);
  });

  it("prioriza o code quando presente", () => {
    expect(translateAuthError({ message: "whatever", code: "invalid_credentials" })).toBe(
      "E-mail ou senha incorretos.",
    );
    expect(translateAuthError({ message: "x", status: 429 })).toMatch(/Muitas tentativas/);
  });

  it("usa fallback genérico em pt-BR para o desconhecido", () => {
    expect(translateAuthError({ message: "Something odd happened" })).toBe(
      "Não foi possível concluir a operação. Tente novamente.",
    );
    expect(translateAuthError(null)).toMatch(/Tente novamente/);
  });
});
