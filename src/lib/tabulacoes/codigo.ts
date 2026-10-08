/**
 * Código da tabulação (tags.codigo_tabulacao, migration 041): número de
 * negócio (Olos) usado pelo mapa tag de saída da IA → tabulação (157) e
 * pela sugestão da IA. Editável na tela de Tabulações.
 */

export type CodigoParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

export const CODIGO_TABULACAO_MAX = 99999;

/** Campo vazio = sem código; senão inteiro de 0 a 99999. */
export function parseCodigoTabulacao(input: string): CodigoParse {
  const raw = input.trim();
  if (!raw) return { ok: true, value: null };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: "O código da tabulação deve ser um número inteiro" };
  }
  const value = Number(raw);
  if (value > CODIGO_TABULACAO_MAX) {
    return { ok: false, error: `O código da tabulação vai até ${CODIGO_TABULACAO_MAX}` };
  }
  return { ok: true, value };
}

/** Outra tabulação da conta já usa este código? (nome dela, ou null) */
export function codigoInUseBy(
  tags: { id: string; name: string; codigo_tabulacao?: number | null }[],
  codigo: number | null,
  exceptTagId?: string | null,
): string | null {
  if (codigo === null) return null;
  const other = tags.find(
    (t) => t.id !== exceptTagId && (t.codigo_tabulacao ?? null) === codigo,
  );
  return other ? other.name : null;
}
