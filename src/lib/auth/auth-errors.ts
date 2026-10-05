// ============================================================
// Erros do Supabase Auth → mensagens em pt-BR.
//
// O Supabase devolve `error.message` em inglês ("Invalid login
// credentials"…). As telas de login/cadastro/recuperação mostravam
// esse texto cru; aqui ele vira uma frase em português, com um
// fallback genérico para o que não estiver mapeado (nunca exibe o
// texto original em inglês para o usuário).
// ============================================================

/** Tamanho mínimo de senha — único lugar da regra (cadastro,
 *  redefinição, troca de senha). */
export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_TOO_SHORT_MESSAGE = `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;

const GENERIC_MESSAGE = "Não foi possível concluir a operação. Tente novamente.";

/** Forma mínima que aceitamos — AuthError do supabase-js, Error comum
 *  ou só uma string. */
type AuthErrorLike =
  | { message?: string | null; code?: string | null; status?: number | null }
  | string
  | null
  | undefined;

// Ordem importa: o primeiro que casar vence.
const RULES: Array<{ codes?: string[]; pattern?: RegExp; message: string }> = [
  {
    codes: ["invalid_credentials"],
    pattern: /invalid login credentials/i,
    message: "E-mail ou senha incorretos.",
  },
  {
    codes: ["email_not_confirmed"],
    pattern: /email not confirmed/i,
    message: "Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.",
  },
  {
    codes: ["user_already_exists", "email_exists"],
    pattern: /user already registered|already been registered/i,
    message: "Já existe uma conta com este e-mail.",
  },
  {
    // weak_password também cobre senha vazada/sem caracteres exigidos:
    // só a mensagem de tamanho vira o texto de "mínimo de caracteres".
    codes: [],
    pattern: /password should be at least/i,
    message: PASSWORD_TOO_SHORT_MESSAGE,
  },
  {
    codes: ["weak_password"],
    pattern: /weak password|password is known to be weak|pwned/i,
    message: "Senha fraca: escolha uma senha mais forte (evite senhas comuns).",
  },
  {
    codes: ["same_password"],
    pattern: /should be different from the old password/i,
    message: "A nova senha deve ser diferente da atual.",
  },
  {
    codes: [
      "over_request_rate_limit",
      "over_email_send_rate_limit",
      "over_sms_send_rate_limit",
    ],
    pattern: /rate limit|too many requests|for security purposes, you can only request/i,
    message: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
  },
  {
    codes: ["otp_expired", "bad_jwt", "session_expired", "flow_state_expired"],
    pattern: /token has expired or is invalid|expired|invalid (jwt|token)/i,
    message: "O link expirou ou é inválido. Solicite um novo.",
  },
  {
    codes: ["session_not_found"],
    pattern: /auth session missing/i,
    message: "Sua sessão expirou. Solicite um novo link de recuperação.",
  },
  {
    codes: ["email_address_invalid"],
    pattern: /unable to validate email address|invalid email/i,
    message: "E-mail inválido.",
  },
  {
    codes: ["signup_disabled"],
    pattern: /signups not allowed/i,
    message: "Novos cadastros estão desativados.",
  },
  {
    pattern: /failed to fetch|network|fetch failed|load failed/i,
    message: "Falha de conexão. Verifique sua internet e tente novamente.",
  },
];

/** Traduz um erro do Supabase Auth para uma mensagem em pt-BR. */
export function translateAuthError(error: AuthErrorLike): string {
  if (!error) return GENERIC_MESSAGE;
  const message = typeof error === "string" ? error : error.message ?? "";
  const code = typeof error === "string" ? null : error.code ?? null;
  const status = typeof error === "string" ? null : error.status ?? null;

  // Texto primeiro (mais específico: um weak_password por tamanho vira
  // "mínimo de caracteres"), depois o código, depois o status.
  for (const rule of RULES) {
    if (rule.pattern && rule.pattern.test(message)) return rule.message;
  }
  for (const rule of RULES) {
    if (code && rule.codes?.includes(code)) return rule.message;
  }
  if (status === 429) {
    return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  }
  return GENERIC_MESSAGE;
}
