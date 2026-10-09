// Erro interno (banco/PostgREST) numa rota: registra o detalhe no servidor e devolve ao cliente uma mensagem genérica.
// Mensagens do Postgres revelam nomes de tabela, coluna, constraint e trechos de SQL — nunca vão para o navegador.
import { NextResponse } from "next/server";

export function internalErrorResponse(
  where: string,
  err: { message?: string; code?: string } | null | undefined,
  message = "Erro interno. Tente novamente.",
): NextResponse {
  console.error(`[${where}]`, err?.code ?? "", err?.message ?? err);
  return NextResponse.json({ error: message }, { status: 500 });
}
