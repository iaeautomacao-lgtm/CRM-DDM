'use client';

import { useRef } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

/**
 * Shared chrome for a searchable, height-bounded tag list: sticky search
 * input on top + a scroll region below, both capped so a large tag set
 * (e.g. 70+ tabulação outcome tags) can never blow out past the viewport.
 * Selection/save logic stays with the caller — this only owns filtering
 * input, layout and arrow-key traversal between rendered tag buttons.
 */

export function useTagButtonRefs() {
  return useRef<Array<HTMLButtonElement | null>>([]);
}

export function focusFirstTagButton(refs: RefObject<Array<HTMLButtonElement | null>>) {
  refs.current[0]?.focus();
}

export function makeTagButtonKeyDownHandler(
  index: number,
  refs: RefObject<Array<HTMLButtonElement | null>>,
  searchRef: RefObject<HTMLInputElement | null>,
) {
  return (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      refs.current[index + 1]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0) searchRef.current?.focus();
      else refs.current[index - 1]?.focus();
    }
  };
}

interface TagPickerBoxProps {
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  onSearchArrowDown: () => void;
  autoFocus?: boolean;
  searchLabel: string;
  isEmpty: boolean;
  emptyMessage?: string;
  children: ReactNode;
}

export function TagPickerBox({
  searchRef,
  query,
  onQueryChange,
  onSearchArrowDown,
  autoFocus,
  searchLabel,
  isEmpty,
  emptyMessage = 'Nenhuma tag encontrada',
  children,
}: TagPickerBoxProps) {
  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onSearchArrowDown();
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="sticky top-0 z-10 border-b border-border bg-popover p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            autoFocus={autoFocus}
            placeholder="Buscar tags..."
            aria-label={searchLabel}
            className="h-8 border-border bg-muted pl-8 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div className="max-h-[min(60vh,480px)] overflow-y-auto p-2">
        {isEmpty ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            {emptyMessage}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">{children}</div>
        )}
      </div>
    </div>
  );
}
