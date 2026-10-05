// Contrato anti-alucinação do Intelligence: todo número que sai de uma
// ferramenta vem como { value, numerator, denominator }, para o modelo (e
// quem audita) poder refazer a conta. `value` é null quando não há
// amostra (denominador 0) — nunca 0 inventado.
//
//   contagem    value = numerator = n, denominator = 1
//   taxa        value = numerator / denominator (fração 0–1, 4 casas)
//   média       numerator = soma, denominator = tamanho da amostra
//   percentil   numerator = amostras ≤ value, denominator = tamanho da amostra

export interface Stat {
  value: number | null;
  numerator: number;
  denominator: number;
}

export function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function count(n: number): Stat {
  return { value: n, numerator: n, denominator: 1 };
}

export function ratio(numerator: number, denominator: number): Stat {
  return {
    value: denominator > 0 ? round(numerator / denominator, 4) : null,
    numerator,
    denominator,
  };
}

/** Média com `digits` casas; a soma também é arredondada (mesmas casas). */
export function mean(samples: number[], digits = 1): Stat {
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    value: samples.length > 0 ? round(sum / samples.length, digits) : null,
    numerator: round(sum, digits),
    denominator: samples.length,
  };
}

/**
 * Percentil pelo método nearest-rank (o mesmo de monitoramento/sla.ts):
 * o menor valor com pelo menos p% das amostras ≤ ele.
 */
export function percentile(samples: number[], p: number, digits = 1): Stat {
  if (samples.length === 0) return { value: null, numerator: 0, denominator: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  const v = sorted[idx];
  return {
    value: round(v, digits),
    numerator: sorted.filter((s) => s <= v).length,
    denominator: sorted.length,
  };
}

/** Diferença absoluta e percentual (fração) entre dois valores. */
export function diff(current: Stat, previous: Stat): { abs: Stat; pct: Stat } {
  if (current.value === null || previous.value === null) {
    return {
      abs: { value: null, numerator: 0, denominator: 0 },
      pct: { value: null, numerator: 0, denominator: 0 },
    };
  }
  const d = round(current.value - previous.value, 4);
  return {
    abs: { value: d, numerator: d, denominator: 1 },
    pct: {
      value: previous.value !== 0 ? round(d / previous.value, 4) : null,
      numerator: d,
      denominator: previous.value,
    },
  };
}
