/**
 * Código da tabulação (tags.codigo_tabulacao, migration 041): número de
 * negócio (Olos) usado pelo mapa tag de saída da IA → tabulação (157) e
 * pela sugestão da IA. Códigos semeados e mapeados pela IA não são editáveis.
 */

export type CodigoParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

export const CODIGO_TABULACAO_MAX = 99999;

const CODIGOS_SEMEADOS_IA = new Set([142, 220, 178, 156, 227, 376, 208]);

/** Só protege a tabulação padrão que está vinculada ao mapa desta conta. */
export function codigoTabulacaoBloqueado(
  tag: { id: string; codigo_tabulacao?: number | null } | null,
  mappedTagIds: ReadonlySet<string>,
): boolean {
  return tag !== null && tag.codigo_tabulacao != null
    && CODIGOS_SEMEADOS_IA.has(tag.codigo_tabulacao) && mappedTagIds.has(tag.id);
}

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
