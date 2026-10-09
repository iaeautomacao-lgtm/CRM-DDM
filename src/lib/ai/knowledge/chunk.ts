// Divisão do texto de um arquivo de conhecimento em trechos para o RAG vetorial (TASK1-D). Módulo puro.
// ~800 tokens por trecho com ~100 de sobreposição; tokens estimados por caracteres (≈ 4 por token em português),
// sem tokenizer: o teto do modelo de embeddings (8.191 tokens) fica muito acima do trecho.

export const CHUNK_TARGET_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 100;
export const CHARS_PER_TOKEN = 4;
/** Teto de trechos por arquivo (≈ 1,1 milhão de caracteres, acima do teto de texto por arquivo). */
export const KB_MAX_CHUNKS_PER_FILE = 400;

export interface KnowledgeChunk {
  index: number;
  content: string;
  tokenEstimate: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Melhor ponto de corte em (min, max]: parágrafo, linha, fim de frase, espaço — nesta ordem. */
function breakPoint(text: string, min: number, max: number): number {
  const window = text.slice(min, max);
  for (const sep of ["\n\n", "\n", ". ", "! ", "? ", "; ", " "]) {
    const at = window.lastIndexOf(sep);
    if (at > 0) return min + at + sep.length;
  }
  return max;
}

export function chunkText(
  text: string,
  options: { targetTokens?: number; overlapTokens?: number } = {},
): KnowledgeChunk[] {
  const size = (options.targetTokens ?? CHUNK_TARGET_TOKENS) * CHARS_PER_TOKEN;
  const overlap = Math.min((options.overlapTokens ?? CHUNK_OVERLAP_TOKENS) * CHARS_PER_TOKEN, Math.floor(size / 2));
  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) end = breakPoint(text, start + Math.floor(size * 0.6), end);
    const content = text.slice(start, end).trim();
    if (content) chunks.push({ index: chunks.length, content, tokenEstimate: estimateTokens(content) });
    if (end >= text.length) break;
    // Recua a sobreposição e avança até o começo de uma palavra (não corta palavra ao meio).
    let next = Math.max(end - overlap, start + 1);
    while (next < end && !/\s/.test(text[next - 1] ?? " ")) next += 1;
    start = next;
  }
  return chunks;
}
