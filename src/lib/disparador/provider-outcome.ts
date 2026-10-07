// Resultado de um envio ao provedor quando a chamada falha SEM resposta de rejeição.
//
// Decisão do dono (P0-3):
//  - Falha de CONEXÃO (a mensagem certamente não saiu: ECONNREFUSED, ENOTFOUND, EAI_AGAIN,
//    UND_ERR_CONNECT_TIMEOUT…) → transitório, retenta como qualquer erro transitório.
//  - 502/503/504 e timeout de resposta (pode ter saído) → "incerto": NÃO reenvia (at-most-once),
//    mas conta para a pausa automática da campanha (ver auto-pause.ts).

/** Mensagem gravada no item cujo resultado externo é incerto (usada também pela pausa automática). */
export const UNCERTAIN_OUTCOME_ERROR =
  "Resultado externo não confirmado; encerrado sem reenvio para evitar duplicidade";

/** Mensagem do item que falhou ANTES de sair (retenta). */
export const NOT_CONNECTED_ERROR =
  "Não foi possível conectar ao provedor; a mensagem não saiu e será tentada novamente";

// Códigos de erro de rede em que o POST nem chegou ao provedor. ECONNRESET/EPIPE/ETIMEDOUT
// ficam de fora de propósito: podem acontecer depois de o corpo ter sido enviado.
const NOT_CONNECTED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function collectCodes(err: unknown, depth = 0, out: string[] = []): string[] {
  if (!err || typeof err !== "object" || depth > 5) return out;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string") out.push(e.code);
  collectCodes(e.cause, depth + 1, out);
  if (Array.isArray(e.errors)) for (const inner of e.errors) collectCodes(inner, depth + 1, out);
  return out;
}

/** A falha aconteceu ANTES de conectar ao provedor (a mensagem certamente não saiu)? */
export function isNotConnectedError(err: unknown): boolean {
  return collectCodes(err).some((code) => NOT_CONNECTED_CODES.has(code));
}

/**
 * Mensagem do item de campanha `tipo=ia` cuja geração de texto falhou (OpenAI 429/timeout/sem chave):
 * NADA é enviado ao cliente; o item fica em 'erro' retentável (sem consumir tentativa) e a pausa
 * automática conta estas ocorrências.
 */
export const AI_UNAVAILABLE_ERROR =
  "Geração de texto por IA indisponível; nada foi enviado ao cliente e o item será tentado novamente";
