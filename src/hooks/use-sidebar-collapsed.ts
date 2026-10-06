"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "wacrm.sidebar.collapsed";

// Mesmo breakpoint do Tailwind `lg` — abaixo dele a sidebar é o drawer
// mobile e nunca vira "rail".
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Atalhos de teclado não devem disparar enquanto o usuário digita.
 * Exportado para teste.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  const attr = el.getAttribute?.("contenteditable");
  return attr !== null && attr !== undefined && attr !== "false";
}

/** Converte o valor salvo ("1"/"0"/null) em booleano — padrão expandido. */
export function parseCollapsed(stored: string | null): boolean {
  return stored === "1";
}

function subscribeDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** `true` em lg+. No servidor (e na hidratação) assume `false`. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

// Store mínima sobre o localStorage: o evento "storage" cobre outras
// abas; os listeners locais cobrem a aba atual (que não recebe o evento).
const listeners = new Set<() => void>();
// Fallback em memória quando o localStorage lança (navegação privada /
// sandbox): o toggle continua funcionando, só não persiste.
let memoryCollapsed = false;

function readCollapsed(): boolean {
  try {
    return parseCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY));
  } catch {
    return memoryCollapsed;
  }
}

function writeCollapsed(next: boolean) {
  memoryCollapsed = next;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Persistência é best-effort.
  }
  listeners.forEach((l) => l());
}

function subscribeCollapsed(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SIDEBAR_COLLAPSED_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Estado "recolhido" da sidebar no desktop, persistido em localStorage.
 * O SSR e a hidratação usam "expandido"; o valor salvo entra logo depois
 * (sem hydration mismatch). Ctrl+B (ou Cmd+B) alterna, exceto com o foco
 * em campos de texto.
 */
export function useSidebarCollapsed() {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);

  const setCollapsed = useCallback((next: boolean) => writeCollapsed(next), []);
  const toggle = useCallback(() => writeCollapsed(!readCollapsed()), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "b") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { collapsed, setCollapsed, toggle };
}
