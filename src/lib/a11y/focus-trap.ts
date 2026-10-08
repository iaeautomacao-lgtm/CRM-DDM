/**
 * Lógica pura de navegação cíclica de foco (Tab / Shift+Tab) em modais.
 * Funções puras independentes de DOM para permitir testes unitários em ambiente Node.
 */

/**
 * Calcula o próximo índice em uma lista circular de elementos focáveis.
 *
 * @param currentIndex Índice do elemento atualmente focado (-1 se nenhum ou fora da lista)
 * @param total Quantidade total de elementos focáveis
 * @param backwards `true` para Shift+Tab (ordem reversa), `false` para Tab (ordem direta)
 * @returns O próximo índice a focar, ou -1 se a lista estiver vazia
 */
export function getNextFocusableIndex(
  currentIndex: number,
  total: number,
  backwards = false
): number {
  if (total <= 0) return -1;
  if (total === 1) return 0;

  if (backwards) {
    if (currentIndex <= 0 || currentIndex >= total) {
      return total - 1;
    }
    return currentIndex - 1;
  }

  if (currentIndex < 0 || currentIndex >= total - 1) {
    return 0;
  }
  return currentIndex + 1;
}

/**
 * Localiza o próximo elemento a ser focado em uma lista de elementos.
 * Se o elemento atual não estiver na lista (ex.: o foco está no container do modal com tabIndex=-1),
 * Tab vai para o primeiro elemento e Shift+Tab vai para o último.
 *
 * @param elements Array de elementos disponíveis
 * @param current Elemento com foco atual (ou null/undefined)
 * @param backwards `true` para Shift+Tab, `false` para Tab
 * @param isCurrent Predicado opcional para verificar correspondência (ex.: verificar se contém o elemento ativo)
 */
export function findNextFocusable<T, C = T>(
  elements: readonly T[],
  current: C | null | undefined,
  backwards = false,
  isCurrent?: (item: T, current: C) => boolean
): T | null {
  if (!elements || elements.length === 0) return null;
  let currentIndex = -1;
  if (current != null) {
    if (isCurrent) {
      currentIndex = elements.findIndex((el) => isCurrent(el, current));
    } else {
      currentIndex = elements.indexOf(current as unknown as T);
    }
  }
  const nextIndex = getNextFocusableIndex(currentIndex, elements.length, backwards);
  return nextIndex >= 0 ? elements[nextIndex] ?? null : null;
}

/** Seletor de elementos focáveis comuns segundo a especificação WAI-ARIA. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  "details > summary:first-of-type",
].join(", ");

/**
 * Verifica se um elemento está visível no DOM e não está desabilitado.
 */
export function isFocusableElement(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  }
  if (typeof window !== "undefined") {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
  }
  return el.getClientRects().length > 0;
}

/**
 * Retorna todos os elementos focáveis e visíveis dentro de um container.
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return candidates.filter(isFocusableElement);
}
