import { NextResponse } from "next/server";
import { resolveWebchatSession, type WebchatSessionRow } from "./sessions";

// Helpers das rotas públicas /api/webchat/[token]/*. Não há login: o token
// da URL é a credencial. Toda rota passa por requireActiveSession, que só
// devolve a sessão se ela estiver ativa e dentro das 24h.

/** Respostas de erro iguais para todas as rotas (a página mostra a tela certa). */
export function webchatError(
  state: "expired" | "revoked" | "not_found" | "not_open" | "invalid" | "rate_limited",
  status: number,
  message?: string
): NextResponse {
  return NextResponse.json(
    { state, error: message ?? state },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function requireActiveSession(
  token: string
): Promise<{ session: WebchatSessionRow } | { response: NextResponse }> {
  const resolved = await resolveWebchatSession(token);
  if (resolved.state === "active") return { session: resolved.session };
  // 410 Gone para link vencido/substituído; 404 para token desconhecido.
  return {
    response: webchatError(resolved.state, resolved.state === "not_found" ? 404 : 410),
  };
}

/** Todas as respostas do Webchat são por sessão: nunca cachear. */
export function webchatJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Limites da página do cliente. */
export const WEBCHAT_LIMITS = {
  textMaxLength: 4000,
  /** Mensagens do cliente por minuto, por sessão (anti-flood). */
  messagesPerMinute: 20,
  /** Mensagens devolvidas por busca. */
  pageSize: 200,
} as const;

/** Caminho de upload do cliente: sempre dentro da pasta da conta e da sessão. */
export function webchatUploadPrefix(session: Pick<WebchatSessionRow, "account_id" | "id">): string {
  return `account-${session.account_id}/webchat/${session.id}/`;
}
