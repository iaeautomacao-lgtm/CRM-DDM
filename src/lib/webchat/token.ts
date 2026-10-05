import { createHash, randomBytes } from "node:crypto";

// Token da sessão de Webchat: vai só na URL (/w/<token>) e funciona como
// credencial do cliente — quem tem o link fala como aquele contato. Por
// isso: 32 bytes aleatórios (base64url, ~43 chars) e, no banco, só o
// sha256 (webchat_sessions.token_hash). Vazamento do banco não expõe links.

/** Validade do link (mesma regra do Webchat da Suri). */
export const WEBCHAT_TTL_MS = 24 * 60 * 60 * 1000;

const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

export function generateWebchatToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashWebchatToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Rejeita rápido (antes de ir ao banco) qualquer coisa que não pode ser um token. */
export function isWellFormedWebchatToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * URL pública da sessão. Exige NEXT_PUBLIC_APP_URL explícita: o link vai
 * para o cliente e precisa apontar para o domínio de produção, não para o
 * host da requisição que gerou o convite.
 */
export function webchatUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) throw new Error("NEXT_PUBLIC_APP_URL precisa estar configurada para gerar links do Webchat");
  return new URL(`/w/${token}`, base).toString();
}
