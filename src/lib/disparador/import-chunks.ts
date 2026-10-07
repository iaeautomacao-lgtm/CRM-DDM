// Importação em blocos (api/disparador/contacts/import). Funções puras,
// sem I/O, para serem testáveis.
//
// Motivo: o corpo de uma requisição para /api/* passa pelo middleware do
// Next 16, que o guarda em memória até proxyClientMaxBodySize (10 MB por
// padrão); um CSV de 100 mil linhas chega truncado. Em vez de subir o
// arquivo inteiro, o assistente já tem as linhas lidas e as envia em blocos
// JSON pequenos, com o mesmo draft_id/campaign_id em todos.

import { phoneVariants } from "./phone-key";

/** Linhas por requisição. */
export const IMPORT_CHUNK_ROWS = 5000;
/** Teto de bytes (JSON) por requisição — folga sobre os 10 MB do middleware. */
export const IMPORT_CHUNK_MAX_BYTES = 6 * 1024 * 1024;
/** Teto aceito pelo servidor numa requisição (defesa contra corpo gigante). */
export const IMPORT_SERVER_MAX_ROWS = 10_000;

/**
 * Divide as linhas em blocos de no máximo `maxRows` linhas e ~`maxBytes`
 * bytes de JSON (planilhas largas enchem o corpo antes das 5.000 linhas).
 * Nunca devolve bloco vazio; uma linha maior que o teto vai sozinha.
 */
export function chunkImportRows<T>(
  rows: readonly T[],
  maxRows = IMPORT_CHUNK_ROWS,
  maxBytes = IMPORT_CHUNK_MAX_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface ImportChunkResults {
  importados: number;
  duplicados: number;
  invalidos: number;
  blacklisted: number;
  variaveis_falhas: number;
  erros: string[];
}

export const EMPTY_IMPORT_RESULTS: ImportChunkResults = {
  importados: 0,
  duplicados: 0,
  invalidos: 0,
  blacklisted: 0,
  variaveis_falhas: 0,
  erros: [],
};

/** Soma o resultado de um bloco ao acumulado (erros limitados a `maxErrors`). */
export function mergeImportResults(
  total: ImportChunkResults,
  chunk: Partial<ImportChunkResults> | null | undefined,
  maxErrors = 20,
): ImportChunkResults {
  const c = chunk ?? {};
  return {
    importados: total.importados + Number(c.importados ?? 0),
    duplicados: total.duplicados + Number(c.duplicados ?? 0),
    invalidos: total.invalidos + Number(c.invalidos ?? 0),
    blacklisted: total.blacklisted + Number(c.blacklisted ?? 0),
    variaveis_falhas: total.variaveis_falhas + Number(c.variaveis_falhas ?? 0),
    erros: [...total.erros, ...(c.erros ?? [])].slice(0, maxErrors),
  };
}

/**
 * Valores de phone_normalized (só dígitos) em que o mesmo número pode estar
 * gravado: com/sem 55 e com/sem o 9º dígito de celular. Usado para buscar,
 * por bloco, só os contatos que podem coincidir — em vez de carregar a
 * conta inteira a cada requisição.
 */
export function contactLookupDigits(phone: string): string[] {
  const out = new Set<string>();
  for (const variant of phoneVariants(phone)) {
    const digits = variant.replace(/\D/g, "");
    if (digits) out.add(digits);
  }
  return [...out];
}

/** Fatias de no máximo `size` itens (para `.in()` sem estourar a URL). */
export function sliceInto<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
