import { describe, expect, it } from "vitest";
import {
  INVALID_CREDENTIALS_MESSAGE,
  MIN_PASSWORD_LENGTH,
  RECOVERY_SENT_MESSAGE,
  recoveryOutcome,
  translateAuthError,
} from "./auth-errors";

describe("translateAuthError", () => {
  it("traduz mensagens comuns do Supabase", () => {
    expect(translateAuthError({ message: "Invalid login credentials" })).toBe(
      "E-mail ou senha incorretos.",
    );
    // Enumeração de contas: e-mail não confirmado e conta existente dão a mesma mensagem de credencial.
    expect(translateAuthError({ message: "Email not confirmed" })).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(translateAuthError({ message: "x", code: "email_not_confirmed" })).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(translateAuthError({ message: "User already registered" })).toBe(INVALID_CREDENTIALS_MESSAGE);
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

describe("recoveryOutcome (recuperação de senha sem enumeração)", () => {
  it("sucesso e erros que dependem da conta caem na mesma tela neutra", () => {
    expect(recoveryOutcome(null)).toEqual({ kind: "sent" });
    expect(recoveryOutcome({ message: "User not found", status: 400 })).toEqual({ kind: "sent" });
    expect(recoveryOutcome({ message: "Email not confirmed" })).toEqual({ kind: "sent" });
    expect(recoveryOutcome({ message: "Something odd happened" })).toEqual({ kind: "sent" });
    expect(RECOVERY_SENT_MESSAGE).toMatch(/Se houver uma conta/);
  });

  it("só limite, e-mail mal formatado e rede aparecem como erro", () => {
    expect(recoveryOutcome({ message: "x", status: 429 })).toEqual({
      kind: "error",
      message: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    });
    expect(recoveryOutcome({ message: "Unable to validate email address: invalid format" })).toEqual({
      kind: "error",
      message: "E-mail inválido.",
    });
    expect(recoveryOutcome(new TypeError("Failed to fetch")).kind).toBe("error");
  });
});
