"use client";

import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { shouldCloseOnEscape } from "@/lib/a11y/dialog-keys";

/**
 * Acessibilidade mínima para modais feitos à mão (div fixed + overlay):
 * - ao abrir, leva o foco para dentro do modal (o container recebe
 *   tabIndex={-1}), para leitor de tela e teclado começarem ali;
 * - Esc fecha quando onClose é passado (onKeyDown no container — com modais empilhados, só o que
 *   tem o foco reage);
 * - ao fechar, devolve o foco para quem abriu o modal.
 *
 * Uso: const dlg = useDialogA11y(open, onClose);
 *      <div ref={dlg.ref} tabIndex={-1} onKeyDown={dlg.onKeyDown} role="dialog" aria-modal="true" ...>
 */
export function useDialogA11y<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose?: () => void
) {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // Só move o foco se nada dentro do modal já o tem (ex.: autoFocus).
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) {
      node.focus({ preventScroll: true });
    }
    return () => {
      if (previous && typeof previous.focus === "function" && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const close = onCloseRef.current;
    if (!close || !shouldCloseOnEscape(e.key, e.target as Element, e.defaultPrevented)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, []);

  return { ref, onKeyDown };
}
