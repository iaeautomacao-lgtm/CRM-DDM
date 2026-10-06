// Comparação simples por linhas entre duas versões de prompt — usada no
// histórico (Configurações → IA e nó de IA do editor de fluxos) para
// mostrar "+3 / −1 linhas" em relação ao texto atual do campo.
// Puro e sem dependências de servidor (roda no navegador).

export interface LineDiffStats {
  added: number;
  removed: number;
}

// Acima disso o LCS fica caro (linhas²); cai para comparação por conjunto.
const MAX_LCS_LINES = 1500;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Linhas em `next` que não estão em `base` (added) e vice-versa (removed). */
export function lineDiffStats(base: string, next: string): LineDiffStats {
  if (base === next) return { added: 0, removed: 0 };
  const a = splitLines(base);
  const b = splitLines(next);

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    const count = (lines: string[]) => {
      const m = new Map<string, number>();
      for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const ca = count(a);
    const cb = count(b);
    let common = 0;
    for (const [line, n] of ca) common += Math.min(n, cb.get(line) ?? 0);
    return { added: b.length - common, removed: a.length - common };
  }

  // LCS clássico com duas linhas de memória.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[b.length];
  return { added: b.length - lcs, removed: a.length - lcs };
}

/** Primeiros caracteres do texto, numa linha só, para a lista. */
export function promptPreview(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
