// "Dieta de tokens" da base de conhecimento (B12).
//
// Antes, TODOS os arquivos da KB entravam no prompt a cada chamada — quase
// todo o custo por conversa. Agora há um teto de tamanho (AI_KB_MAX_CHARS,
// padrão 40.000 caracteres ≈ 10k tokens): abaixo dele nada muda (mesmo texto
// de antes); acima, entram os arquivos mais relevantes para o que o cliente
// acabou de dizer, na ordem original, e o último pode ser truncado.

export interface KbFile {
  name: string;
  content: string | null;
}

export const KB_DEFAULT_MAX_CHARS = 40_000;
const KB_TRUNCATION_NOTE = "\n[... trecho omitido por tamanho ...]";
/** Sobra mínima para valer a pena incluir um arquivo truncado. */
const KB_MIN_PARTIAL_CHARS = 500;

export function kbMaxChars(): number {
  const v = Number.parseInt(process.env.AI_KB_MAX_CHARS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : KB_DEFAULT_MAX_CHARS;
}

const STOPWORDS = new Set([
  "a", "o", "e", "de", "da", "do", "em", "um", "uma", "que", "para", "por", "com", "no", "na",
  "os", "as", "se", "eu", "me", "meu", "minha", "foi", "ser", "tem", "mais", "mas", "como", "voce",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function formatFile(file: KbFile, content: string): string {
  return `[ARQUIVO: ${file.name}]\n${content}\n---`;
}

/**
 * Monta o bloco de contexto da KB respeitando `maxChars`. `query` é o texto
 * recente do cliente, usado para ranquear arquivos quando não cabe tudo.
 * Retorna "" se não houver arquivos.
 */
export function buildKnowledgeBaseContext(
  files: KbFile[],
  query: string,
  maxChars: number = kbMaxChars(),
): string {
  const usable = files.filter((f) => (f.content ?? "") !== "" || f.name);
  if (usable.length === 0) return "";

  const full = usable.map((f) => formatFile(f, f.content ?? ""));
  const fullText = full.join("\n\n");
  if (fullText.length <= maxChars) return fullText;

  // Não cabe: ranqueia por sobreposição de termos (nome pesa mais que corpo).
  const queryTerms = new Set(tokenize(query));
  const scored = usable.map((file, index) => {
    const nameTerms = new Set(tokenize(file.name));
    const bodyTerms = new Set(tokenize(file.content ?? ""));
    let score = 0;
    for (const t of queryTerms) {
      if (nameTerms.has(t)) score += 3;
      if (bodyTerms.has(t)) score += 1;
    }
    return { file, index, score };
  });
  // Mais relevante primeiro; empate mantém a ordem original (estável).
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = new Map<number, string>();
  let used = 0;
  for (const { file, index } of ranked) {
    const sep = chosen.size > 0 ? 2 : 0;
    const block = formatFile(file, file.content ?? "");
    if (used + sep + block.length <= maxChars) {
      chosen.set(index, block);
      used += sep + block.length;
      continue;
    }
    const room = maxChars - used - sep;
    const overhead = formatFile(file, "").length + KB_TRUNCATION_NOTE.length;
    const body = room - overhead;
    if (body >= KB_MIN_PARTIAL_CHARS) {
      chosen.set(index, formatFile(file, (file.content ?? "").slice(0, body) + KB_TRUNCATION_NOTE));
      used += sep + (overhead + body);
    }
    // Arquivos menos relevantes seguintes ainda podem caber inteiros.
  }

  return [...chosen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block)
    .join("\n\n");
}
