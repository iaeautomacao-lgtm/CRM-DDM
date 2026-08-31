"use client";

// ============================================================
// MonitorFiltersPanel — shared filter bar above the Fases/Agentes/
// Equipes tabs. Mirrors the Fortics layout: a collapsible panel with
// one control per criterion, "Pesquisar" and "Limpar filtros" buttons.
//
// Two-step apply, matching Fortics: this panel holds its own DRAFT
// state, seeded from (and reset by) the parent's APPLIED `filters`
// prop. Checking a box doesn't filter anything yet — only "Pesquisar"
// commits the draft via `onApply`. "Limpar filtros" resets both the
// draft here and the applied state in the parent via `onClear`.
// ============================================================

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EMPTY_FILTERS, hasActiveFilters, type MonitorFilters } from "@/lib/monitoramento/filters";
import { MultiSelectFilter, type MultiSelectOption } from "./multi-select-filter";

export function MonitorFiltersPanel({
  agentOptions,
  teamOptions,
  channelOptions,
  tagOptions,
  filters,
  onApply,
  onClear,
}: {
  agentOptions: MultiSelectOption[];
  teamOptions: MultiSelectOption[];
  channelOptions: MultiSelectOption[];
  tagOptions: MultiSelectOption[];
  /** The currently APPLIED filters (owned by the page). */
  filters: MonitorFilters;
  onApply: (filters: MonitorFilters) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<MonitorFilters>(filters);

  // Re-seed the draft whenever the applied filters change from outside
  // (e.g. "Limpar filtros" while the panel happens to be collapsed) —
  // keeps the two in sync without the draft silently going stale.
  useEffect(() => {
    setDraft(filters);
  }, [filters]);

  const active = hasActiveFilters(filters);

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <SlidersHorizontal className="size-4 text-primary" />
          Filtros
          {active && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              Ativos
            </span>
          )}
        </span>
        {open ? (
          <ChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t border-border p-4">
          <div className="flex flex-wrap items-end gap-3">
            <MultiSelectFilter
              label="Agentes"
              options={agentOptions}
              selectedIds={draft.agentIds}
              onChange={(ids) => setDraft((d) => ({ ...d, agentIds: ids }))}
              emptyText="Nenhum agente na conta."
            />
            <MultiSelectFilter
              label="Equipes"
              options={teamOptions}
              selectedIds={draft.teamIds}
              onChange={(ids) => setDraft((d) => ({ ...d, teamIds: ids }))}
              emptyText="Nenhuma equipe criada ainda."
            />
            <MultiSelectFilter
              label="Canais"
              options={channelOptions}
              selectedIds={draft.channels}
              onChange={(ids) => setDraft((d) => ({ ...d, channels: ids }))}
              emptyText="Nenhum canal WAHA configurado."
            />
            <div className="min-w-[220px] flex-1">
              <Input
                value={draft.contactQuery}
                onChange={(e) => setDraft((d) => ({ ...d, contactQuery: e.target.value }))}
                placeholder="Contato (nome ou número)"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <MultiSelectFilter
              label="Tags"
              options={tagOptions}
              selectedIds={draft.tagIds}
              onChange={(ids) => setDraft((d) => ({ ...d, tagIds: ids }))}
              emptyText="Nenhuma tag ainda."
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" onClick={() => onApply(draft)}>Pesquisar</Button>
            <Button
              variant="outline"
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                onClear();
              }}
            >
              Limpar filtros
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
