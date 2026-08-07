"use client";

import { useCallback, useState } from "react";

/**
 * Generic multi-select state — one Set<string> of selected ids, plus
 * helpers for a single toggle and a "select all / deselect all" bulk
 * toggle (for column-header checkboxes covering a specific subset of
 * ids). Not Monitoramento-specific on purpose: it's just a Set with
 * ergonomic setters, reusable anywhere a list needs checkboxes.
 */
export function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], value: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  return { selected, toggle, setMany, clear };
}
