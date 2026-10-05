"use client";

// Seletor de período único dos Relatórios: atalhos + De/Até. Só altera o
// rascunho do filtro — cada tela continua aplicando com o próprio botão.

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  PERIOD_PRESETS,
  matchPreset,
  normalizeRange,
  presetRange,
  type PeriodRange,
} from "@/lib/relatorios/period";

export function PeriodFilter({
  value,
  onChange,
}: {
  value: PeriodRange;
  onChange: (range: PeriodRange) => void;
}) {
  const active = matchPreset(value);
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">Período</span>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Atalhos de período" className="flex flex-wrap gap-1">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={active === p.id}
              onClick={() => onChange(presetRange(p.id))}
              className={cn(
                "h-9 rounded-md border px-2.5 text-xs font-medium transition-colors",
                active === p.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Período (de)"
            value={value.dateFrom}
            onChange={(e) => onChange(normalizeRange({ ...value, dateFrom: e.target.value }))}
            className="w-38"
          />
          <span className="text-xs text-muted-foreground">até</span>
          <Input
            type="date"
            aria-label="Período (até)"
            value={value.dateTo}
            onChange={(e) => onChange(normalizeRange({ ...value, dateTo: e.target.value }))}
            className="w-38"
          />
        </div>
      </div>
    </div>
  );
}
