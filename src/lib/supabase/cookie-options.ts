// Opções dos cookies de sessão do Supabase nos 3 clientes (navegador, servidor e /auth/callback) — revisão de segurança 13/10, item 4.
// Antes: defaults do @supabase/ssr (sem `Secure`, validade de 400 dias). O cookie continua legível por JS (o navegador lê a sessão para o realtime
// e o refresh; HttpOnly exigiria mudar a arquitetura), então a defesa em profundidade é: só trafega por HTTPS em produção, SameSite=Lax e vida curta.
//
// maxAge: 7 dias. DEVE ficar igual ou abaixo do "time-box" configurado em Supabase → Authentication → Sessions (o cookie expirar antes do
// servidor só pede novo login; o contrário deixa um cookie morto no navegador). Não altere o `name`: o middleware deriva o nome padrão
// `sb-<ref>-auth-token` do NEXT_PUBLIC_SUPABASE_URL.

/** Validade do cookie de sessão, em segundos (7 dias). */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface SessionCookieOptions {
  path: string;
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
}

/** `secure` só em produção: em desenvolvimento (http://localhost) o navegador descartaria o cookie. */
export function sessionCookieOptions(env: string | undefined = process.env.NODE_ENV): SessionCookieOptions {
  return { path: "/", sameSite: "lax", secure: env === "production", maxAge: SESSION_COOKIE_MAX_AGE_SECONDS };
}
