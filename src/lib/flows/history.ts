// Desfazer/refazer do editor de fluxos (puro — o provider do editor guarda
// a instância num ref).
//
// Cada edição registra o estado ANTERIOR. Edições em sequência rápida
// (digitar num campo, arrastar um nó) viram um passo só: dentro de
// `coalesceMs` desde a última, o passo já registrado continua valendo.
// Uma edição nova depois de desfazer descarta o "refazer".

export interface History<T> {
  past: T[];
  future: T[];
  /** Momento da última edição registrada (para agrupar). */
  lastAt: number;
}

export const HISTORY_LIMIT = 100;
export const HISTORY_COALESCE_MS = 700;

export function createHistory<T>(): History<T> {
  return { past: [], future: [], lastAt: 0 };
}

/** Registra uma edição: `prev` é o estado de antes dela. */
export function recordEdit<T>(
  h: History<T>,
  prev: T,
  now: number,
  coalesceMs = HISTORY_COALESCE_MS,
): History<T> {
  const grouped = h.past.length > 0 && now - h.lastAt < coalesceMs;
  const past = grouped ? h.past : [...h.past, prev].slice(-HISTORY_LIMIT);
  return { past, future: [], lastAt: now };
}

/** Volta um passo. `current` vai para o "refazer". null = nada a desfazer. */
export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.past.length === 0) return null;
  const state = h.past[h.past.length - 1];
  return {
    state,
    // lastAt zerado: a próxima edição abre um passo novo, não se funde
    // com o que foi desfeito.
    history: { past: h.past.slice(0, -1), future: [current, ...h.future], lastAt: 0 },
  };
}

/** Avança um passo desfeito. null = nada a refazer. */
export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.future.length === 0) return null;
  const [state, ...rest] = h.future;
  return {
    state,
    history: { past: [...h.past, current].slice(-HISTORY_LIMIT), future: rest, lastAt: 0 },
  };
}

/** Atalho de teclado do editor (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y). */
export function historyShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !e.shiftKey) return "redo";
  return null;
}
