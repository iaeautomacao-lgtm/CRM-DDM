import { NextResponse } from "next/server";
import { clientIp } from "@/lib/audit/context";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
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

/**
 * Limite por IP + token das rotas públicas do Webchat (AP-19): flood de leitura/abertura/upload com um token válido.
 * Chamar ANTES de resolver a sessão (não gasta consulta ao banco). `kind`: 'read' (GET/poll/mídia) ou 'write' (abrir, enviar).
 * Devolve a resposta 429 (com Retry-After) ou null.
 */
export async function webchatRateLimit(
  request: Request,
  token: string,
  kind: "read" | "write",
): Promise<NextResponse | null> {
  const ip = clientIp(request.headers) ?? "unknown";
  const options = kind === "read" ? RATE_LIMITS.webchatRead : RATE_LIMITS.webchatWrite;
  const result = await checkRateLimit(`webchat:${kind}:${ip}:${token.slice(0, 32)}`, options);
  if (result.success) return null;
  const response = webchatError("rate_limited", 429, "Muitas requisições. Aguarde um instante.");
  response.headers.set("Retry-After", String(Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))));
  return response;
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
