"use client";

// ============================================================
// MultiSelectFilter — generic checkbox-list-in-a-popover multi-select.
// Same structure as the tag filter in contacts/page.tsx (Popover +
// search input + Checkbox list + "Limpar" link) — extracted into a
// reusable control since the Monitoramento filter panel needs the
// same shape 4 times (Agentes/Equipes/Canais/Tags) and duplicating it
// 4x would drift on the first tweak.
// ============================================================

import { useState } from "react";
import { Filter, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface MultiSelectOption {
  id: string;
  label: string;
  /** Optional color dot (e.g. a tag's color). */
  swatch?: string;
}

// Below this many options the search box is just noise — matches the
// contacts page's tag filter, which always shows it regardless of
// count, but our lists (agents, teams, channels) are typically much
// shorter than a tag dictionary, so we hide it until it'd help.
const SEARCH_THRESHOLD = 6;

export function MultiSelectFilter({
  label,
  options,
  selectedIds,
  onChange,
  emptyText = "Nenhuma opção disponível.",
}: {
  label: string;
  options: MultiSelectOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  function toggle(id: string) {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id],
    );
  }

  return (
    <Popover
      onOpenChange={(next) => {
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="border-border text-muted-foreground hover:bg-muted"
          />
        }
      >
        <Filter className="size-4" />
        {label}
        {selectedIds.length > 0 && (
          <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
            {selectedIds.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium text-popover-foreground">{label}</span>
          {selectedIds.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Limpar
            </button>
          )}
        </div>

        {options.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <>
            {options.length > SEARCH_THRESHOLD && (
              <div className="border-b border-border p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                    placeholder="Buscar..."
                    className="h-8 border-border bg-muted pl-8 text-sm text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            )}
            <div className="max-h-64 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                  Nada encontrado
                </p>
              ) : (
                filtered.map((opt) => (
                  <label
                    key={opt.id}
                    className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={selectedIds.includes(opt.id)}
                      onCheckedChange={() => toggle(opt.id)}
                      aria-label={`Filtrar por ${opt.label}`}
                    />
                    {opt.swatch ? (
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: opt.swatch }}
                      />
                    ) : null}
                    <span className="truncate text-sm text-popover-foreground">{opt.label}</span>
                  </label>
                ))
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
