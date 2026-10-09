"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Loader2, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMePermissions } from "@/hooks/use-me-permissions";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import {
  PALETTE_ITEMS,
  isCurrentPaletteItem,
  isPaletteItemVisible,
  searchPalette,
  type PaletteItem,
} from "@/lib/command-palette";

/** Evento global para abrir a paleta de qualquer lugar (ex.: botão do header). */
export const OPEN_PALETTE_EVENT = "ddm:open-command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Busca rápida (porte do command-palette.js do protótipo DDM):
 * Ctrl/Cmd+K abre e fecha; "/" abre quando não se está digitando;
 * ↑ ↓ navegam, Enter abre, Esc fecha. Lista só telas que o papel acessa
 * (GET /api/me/permissions) — ver lib/command-palette.ts.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: me, loading, error } = useMePermissions();
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const visible = useMemo(
    () => (me ? PALETTE_ITEMS.filter((item) => isPaletteItemVisible(item, me)) : []),
    [me],
  );
  const results = useMemo(() => searchPalette(visible, query), [visible, query]);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const show = useCallback(() => {
    setQuery("");
    setActive(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (open) setOpen(false);
        else show();
      } else if (e.key === "/" && !open && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(document.activeElement)) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, show);
    };
  }, [open, show]);

  // Mantém o item ativo visível ao navegar pelo teclado.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const go = (item: PaletteItem) => {
    setOpen(false);
    router.push(item.href);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(results.length - 1, activeIndex + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, activeIndex - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIndex];
      if (item) go(item);
    }
  };

  const search = searchParams.toString();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          aria-label="Busca rápida"
          className="fixed inset-x-4 top-[12vh] z-50 mx-auto flex max-h-[70vh] w-auto max-w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-overlay outline-none data-open:animate-ddm-menu data-closed:animate-out data-closed:fade-out-0"
        >
          <div className="flex items-center gap-2.5 border-b border-border px-3.5">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKey}
              placeholder="Buscar telas e atalhos…"
              aria-label="Buscar"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">Esc</kbd>
          </div>

          <div ref={listRef} id={listId} role="listbox" aria-label="Resultados" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {loading ? (
              <p className="flex items-center justify-center gap-2 px-3 py-6 text-[13px] text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Carregando suas telas…
              </p>
            ) : error ? (
              <p className="px-3 py-6 text-center text-[13px] text-muted-foreground" role="alert">
                Não foi possível carregar suas permissões. Feche e tente de novo.
              </p>
            ) : results.length === 0 ? (
              <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                Nada encontrado para “{query}”.
              </p>
            ) : (
              results.map((item, i) => {
                const selected = i === activeIndex;
                const current = isCurrentPaletteItem(item, pathname, search);
                return (
                  <div
                    key={item.href}
                    id={`${listId}-${i}`}
                    data-index={i}
                    data-no-ripple
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => {
                      if (i !== activeIndex) setActive(i);
                    }}
                    onClick={() => go(item)}
                    className={cn(
                      "flex min-h-[38px] cursor-pointer items-center gap-2.5 rounded-md px-2.5",
                      selected ? "bg-selected shadow-[inset_2px_0_0_var(--primary)]" : "bg-transparent",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{item.label}</span>
                    {current && <span className="text-[11px] text-primary-text">Você está aqui</span>}
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">{item.group}</span>
                  </div>
                );
              })
            )}
          </div>

          <div className="hidden gap-3.5 border-t border-border px-3.5 py-2 text-[11.5px] text-muted-foreground sm:flex" aria-hidden="true">
            <span>↑ ↓ navegar</span>
            <span>Enter abrir</span>
            <span>Ctrl K abrir/fechar</span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
