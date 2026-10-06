import { describe, expect, it } from "vitest";
import {
  LOGIN_AFTER_RESET_PATH,
  callbackFailurePath,
  hasRecoveryLinkError,
  isPasswordResetSuccess,
  resolveRecoveryStatus,
} from "./recovery-link";

describe("callbackFailurePath", () => {
  it("link de recuperação inválido volta para a tela de redefinição com aviso", () => {
    expect(callbackFailurePath("/reset-password")).toBe("/reset-password?error=link-invalid");
    expect(callbackFailurePath("/reset-password?x=1")).toBe("/reset-password?error=link-invalid");
  });

  it("outros links continuam indo para o login", () => {
    expect(callbackFailurePath("/dashboard")).toBe("/login?error=auth-callback-failed");
    expect(callbackFailurePath("/reset-password-extra")).toBe("/login?error=auth-callback-failed");
  });
});

describe("hasRecoveryLinkError", () => {
  it("detecta erro na query ou no fragmento", () => {
    expect(hasRecoveryLinkError("?error=link-invalid", "")).toBe(true);
    expect(hasRecoveryLinkError("", "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid")).toBe(true);
    expect(hasRecoveryLinkError("?error_code=otp_expired", "")).toBe(true);
  });

  it("sem erro = false", () => {
    expect(hasRecoveryLinkError("", "")).toBe(false);
    expect(hasRecoveryLinkError("?next=/x", "#section")).toBe(false);
  });
});

describe("resolveRecoveryStatus", () => {
  it("formulário só com sessão e sem erro no link", () => {
    expect(resolveRecoveryStatus({ linkError: false, hasSession: true })).toBe("ready");
    expect(resolveRecoveryStatus({ linkError: false, hasSession: false })).toBe("invalid");
    expect(resolveRecoveryStatus({ linkError: true, hasSession: true })).toBe("invalid");
  });
});

describe("aviso de sucesso no login", () => {
  it("reconhece ?reset=ok", () => {
    expect(LOGIN_AFTER_RESET_PATH).toBe("/login?reset=ok");
    expect(isPasswordResetSuccess("ok")).toBe(true);
    expect(isPasswordResetSuccess(null)).toBe(false);
    expect(isPasswordResetSuccess("1")).toBe(false);
  });
});
