// Regras de teclado dos modais "artesanais" (div fixed + overlay) do
// disparador. Os modais shadcn/base-ui já tratam Esc e foco sozinhos;
// estes não, então centralizamos aqui a decisão para poder testar.

/** Elemento mínimo de que a regra precisa (facilita teste sem DOM). */
export interface EscapeTargetLike {
  closest?: (selector: string) => unknown;
}

// Popups que tratam o próprio Esc (Select, menus, combobox). Se o Esc
// nasceu dentro de um deles, quem fecha é o popup — não o modal inteiro.
const OWN_ESCAPE_SELECTOR =
  '[role="listbox"],[role="menu"],[role="combobox"][aria-expanded="true"]';

/**
 * Diz se um keydown deve fechar o modal.
 * - Só a tecla Escape;
 * - ignora se outro handler já tratou o evento (defaultPrevented);
 * - ignora se o foco está num popup que fecha a si mesmo (Select etc.).
 */
export function shouldCloseOnEscape(
  key: string,
  target: EscapeTargetLike | null | undefined,
  defaultPrevented = false
): boolean {
  if (key !== "Escape" || defaultPrevented) return false;
  if (target && typeof target.closest === "function" && target.closest(OWN_ESCAPE_SELECTOR)) {
    return false;
  }
  return true;
}
