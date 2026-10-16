// Estatística da bancada local do worker (scripts/loadtest/worker-bench). Só funções puras: percentis, justiça entre números e capacidade por núcleo.

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Índice de Jain: 1 = todos iguais; 1/n = um número leva tudo. Lista vazia ou só zeros = 1. */
export function jainIndex(values: readonly number[]): number {
  const total = sum(values);
  const squares = sum(values.map((v) => v * v));
  if (values.length === 0 || squares === 0) return 1;
  return (total * total) / (values.length * squares);
}

/** Recorta `[from, from + length)` de um vetor de contagens por segundo (faltando = 0). */
export function windowOf(perSecond: readonly number[], from: number, length: number): number[] {
  return Array.from({ length }, (_, i) => perSecond[from + i] ?? 0);
}

export interface NumberRate {
  sessionId: string;
  /** Envios/s médios na janela medida. */
  mean: number;
  /** Maior envios/s em 1 s. */
  peak: number;
  /** Menor média de 5 s (o "pior trecho"). */
  worst5s: number;
  sends: number;
}

export function numberRate(sessionId: string, perSecond: readonly number[]): NumberRate {
  const sends = sum(perSecond);
  let worst5s = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 5 <= perSecond.length; i += 1) worst5s = Math.min(worst5s, sum(perSecond.slice(i, i + 5)) / 5);
  return {
    sessionId,
    mean: perSecond.length ? sends / perSecond.length : 0,
    peak: Math.max(0, ...perSecond),
    worst5s: Number.isFinite(worst5s) ? worst5s : perSecond.length ? sends / perSecond.length : 0,
    sends,
  };
}

export interface Fairness {
  jain: number;
  /** menor média ÷ maior média entre os números. */
  minOverMax: number;
  /** menor média ÷ meta (taxa configurada). */
  minOverTarget: number;
}

export function fairness(rates: readonly NumberRate[], targetPerSecond: number): Fairness {
  const means = rates.map((r) => r.mean);
  const lo = means.length ? Math.min(...means) : 0;
  const hi = means.length ? Math.max(...means) : 0;
  return { jain: jainIndex(means), minOverMax: hi > 0 ? lo / hi : 1, minOverTarget: targetPerSecond > 0 ? lo / targetPerSecond : 1 };
}

export interface CpuSample {
  /** CPU de usuário + sistema consumida na janela, em ms. */
  cpuMs: number;
  /** Relógio da janela, em ms. */
  wallMs: number;
}

/** Núcleos médios usados na janela (1,0 = um núcleo inteiro). */
export function coresUsed(sample: CpuSample): number {
  return sample.wallMs > 0 ? sample.cpuMs / sample.wallMs : 0;
}

export interface Capacity {
  /** CPU do processo por envio, em ms. */
  cpuMsPerSend: number;
  /** Números a `ratePerSecond` que 1 núcleo sustentaria a 100 % (extrapolação linear). */
  numbersPerCoreFull: number;
  /** Idem com folga: só `headroom` (padrão 70 %) do núcleo. */
  numbersPerCoreSafe: number;
}

/** Extrapola a capacidade pelo custo de CPU por envio medido (independe de o teste ter saturado). */
export function capacityPerCore(cpuMs: number, sends: number, ratePerSecond: number, headroom = 0.7): Capacity {
  const cpuMsPerSend = sends > 0 ? cpuMs / sends : Number.POSITIVE_INFINITY;
  const perNumberCoreShare = (ratePerSecond * cpuMsPerSend) / 1000; // núcleos por número
  const full = perNumberCoreShare > 0 && Number.isFinite(perNumberCoreShare) ? 1 / perNumberCoreShare : 0;
  return { cpuMsPerSend, numbersPerCoreFull: full, numbersPerCoreSafe: full * headroom };
}

export const fixed = (value: number, digits = 1): string => (Number.isFinite(value) ? value.toFixed(digits) : "—");
