// Erro interno (banco/PostgREST/GoTrue) numa rota: registra o detalhe no servidor e devolve ao cliente uma mensagem genérica com código.
// Mensagens do Postgres revelam nomes de tabela, coluna, constraint e trechos de SQL — nunca vão para o navegador.
// Plano de segurança 13/10 (Âncora 3): a resposta leva `code` estável e `ref` curta; a mesma `ref` aparece no log do servidor (mascarado).
// Mensagens de DOMÍNIO úteis ao usuário (erros da Meta em templates, RAISE das RPCs de membros) NÃO passam por aqui.
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { safeDbError } from "@/lib/privacy/mask";

export const INTERNAL_ERROR_MESSAGE = "Erro interno. Tente novamente.";

export interface InternalErrorOptions {
  /** Texto para o usuário (sem detalhe técnico). */
  message?: string;
  status?: number;
  /** Código estável para o front/suporte (padrão: internal_error). */
  code?: string;
}

export function internalErrorResponse(
  where: string,
  err: { message?: string; code?: string } | null | undefined,
  messageOrOptions: string | InternalErrorOptions = INTERNAL_ERROR_MESSAGE,
): NextResponse {
  const options: InternalErrorOptions = typeof messageOrOptions === "string" ? { message: messageOrOptions } : messageOrOptions;
  const ref = randomBytes(4).toString("hex");
  const safe = safeDbError(err);
  console.error(`[${where}]`, safe.code ?? "", safe.message, `ref=${ref}`);
  return NextResponse.json(
    { error: options.message ?? INTERNAL_ERROR_MESSAGE, code: options.code ?? "internal_error", ref },
    { status: options.status ?? 500 },
  );
}
