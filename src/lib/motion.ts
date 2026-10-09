// Núcleo puro do sistema de movimento (porte do motion.js do protótipo DDM).
// As animações em si são CSS (globals.css, utilitários animate-ddm-*); aqui
// fica só o que precisa de JS: curvas, preferência de movimento reduzido e
// a contagem animada de números.

/** Curva padrão do protótipo — cubic-bezier(.22,.61,.36,1). */
export const EASE_DDM = "cubic-bezier(0.22, 0.61, 0.36, 1)";
/** Curva com mola (modais) — cubic-bezier(.34,1.3,.64,1). */
export const EASE_DDM_SPRING = "cubic-bezier(0.34, 1.3, 0.64, 1)";

/** Duração da contagem animada de números (ms), igual ao protótipo. */
export const COUNT_UP_MS = 900;

/** Desaceleração quártica usada na contagem (1 - (1 - p)^4). */
export function easeOutQuart(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return 1 - Math.pow(1 - p, 4);
}

/** Valor intermediário da contagem entre `from` e `to` no instante `elapsedMs`. */
export function countUpValue(from: number, to: number, elapsedMs: number, durationMs = COUNT_UP_MS): number {
  if (durationMs <= 0) return to;
  return from + (to - from) * easeOutQuart(elapsedMs / durationMs);
}

/**
 * Vale a pena animar? Igual ao protótipo: números pequenos (|n| < 2) e não
 * finitos aparecem direto, sem contagem.
 */
export function shouldCountUp(to: number): boolean {
  return Number.isFinite(to) && Math.abs(to) >= 2;
}

/** O usuário pediu movimento reduzido (SO/navegador)? Falso no servidor. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
