// Achar e trocar a URL de uma mensagem (PURO). A operação informa o link que quer (campanha/planilha); o CRM troca por trás pelo link
// rastreado do UTMpay, UM por envio. Só a PRIMEIRA URL da mensagem é trocada (o link de pagamento/negociação); as demais ficam como estão.
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/i;
const TRAILING = /[.,;:!?}]+$/;
export const MAX_DESTINATION_CHARS = 2048;

export interface FoundUrl {
  /** URL limpa (sem pontuação final). */
  url: string;
  /** Posição e tamanho do trecho original (com a pontuação final), para a troca. */
  start: number;
  length: number;
}

/** Primeira URL http(s) do texto, ou null. */
export function findFirstUrl(text: string): FoundUrl | null {
  const m = URL_PATTERN.exec(text);
  if (!m || m.index === undefined) return null;
  const url = m[0].replace(TRAILING, "");
  if (!url || url.length > MAX_DESTINATION_CHARS) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url, start: m.index, length: m[0].length };
}

/** Troca a URL achada por `replacement`, preservando a pontuação final que acompanhava. */
export function replaceFoundUrl(text: string, found: FoundUrl, replacement: string): string {
  const tail = text.slice(found.start + found.url.length, found.start + found.length);
  return text.slice(0, found.start) + replacement + tail + text.slice(found.start + found.length);
}

/** Primeira variável do corpo (Meta/template) que contém uma URL. */
export function findFirstUrlInVariables(variables: readonly string[]): { index: number; found: FoundUrl } | null {
  for (let index = 0; index < variables.length; index++) {
    const found = findFirstUrl(String(variables[index] ?? ""));
    if (found) return { index, found };
  }
  return null;
}
