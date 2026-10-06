// Link de redefinição de senha (puro — usado por /auth/callback,
// /reset-password e /login).
//
// Fluxo: /forgot-password → e-mail do Supabase → /auth/callback?code=…
// &next=/reset-password (troca o código por uma sessão de recuperação) →
// /reset-password. Link vencido ou já usado chega sem `code` ou com
// `error`/`error_code` (na query ou no fragmento #), e a troca falha.

export const RESET_PASSWORD_PATH = "/reset-password";
export const FORGOT_PASSWORD_PATH = "/forgot-password";
/** Valor de `?error=` em /reset-password quando o link não vale mais. */
export const RECOVERY_LINK_INVALID = "link-invalid";
/** Destino depois de trocar a senha: login com aviso de sucesso. */
export const LOGIN_AFTER_RESET_PATH = "/login?reset=ok";

export type RecoveryStatus = "checking" | "ready" | "invalid";

/**
 * Para onde o /auth/callback manda quando não conseguiu abrir a sessão.
 * Link de recuperação vai para a própria tela de redefinição, que explica
 * que o link expirou e oferece pedir outro; o resto continua no login.
 */
export function callbackFailurePath(next: string): string {
  const pathname = next.split(/[?#]/)[0];
  if (pathname === RESET_PASSWORD_PATH) {
    return `${RESET_PASSWORD_PATH}?error=${RECOVERY_LINK_INVALID}`;
  }
  return "/login?error=auth-callback-failed";
}

/**
 * O Supabase devolve erro do link (ex.: `error_code=otp_expired`) na query
 * ou no fragmento; o callback devolve `error=link-invalid`. Qualquer um
 * deles = link inválido.
 */
export function hasRecoveryLinkError(search: string, hash: string): boolean {
  const sources = [search.replace(/^\?/, ""), hash.replace(/^#/, "")];
  return sources.some((raw) => {
    if (!raw) return false;
    const params = new URLSearchParams(raw);
    return params.has("error") || params.has("error_code") || params.has("error_description");
  });
}

/** Mostra o formulário só com sessão de recuperação e sem erro no link. */
export function resolveRecoveryStatus(input: {
  linkError: boolean;
  hasSession: boolean;
}): Exclude<RecoveryStatus, "checking"> {
  if (input.linkError) return "invalid";
  return input.hasSession ? "ready" : "invalid";
}

/** `?reset=ok` no login: senha trocada com sucesso. */
export function isPasswordResetSuccess(value: string | null): boolean {
  return value === "ok";
}
