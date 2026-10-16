"use client";

import { useSyncExternalStore } from "react";

// Relógio único para quem precisa de "agora" andando (tempo de espera dos cartões): um só setInterval para todos os
// assinantes, que só existe enquanto houver ao menos um. Cada assinante renderiza sozinho a cada tick; quem o contém
// (o cartão memoizado) não renderiza de novo.

const TICK_MS = 30_000;

let now = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  // Antes do primeiro assinante o valor ainda é 0: lê a hora na hora (e vira o valor compartilhado).
  if (now === 0) now = Date.now();
  return now;
}

/** Hora atual (ms), atualizada a cada 30 s e compartilhada entre todos os componentes que a usam. */
export function useSharedClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
