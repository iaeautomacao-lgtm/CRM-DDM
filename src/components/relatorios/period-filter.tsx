"use client";

// Seletor de período único dos Relatórios: atalhos + De/Até. Só altera o
// rascunho do filtro — cada tela continua aplicando com o próprio botão.

import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ddm/segmented";
import {
  PERIOD_PRESETS,
  matchPreset,
  normalizeRange,
  presetRange,
  type PeriodPreset,
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
        {/* Período personalizado (De/Até fora dos atalhos) não marca nenhum atalho. */}
        <Segmented<PeriodPreset | "custom">
          ariaLabel="Atalhos de período"
          size="lg"
          value={active ?? "custom"}
          onChange={(v) => v !== "custom" && onChange(presetRange(v))}
          options={PERIOD_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            type="date"
            aria-label="Período (de)"
            value={value.dateFrom}
            onChange={(e) => onChange(normalizeRange({ ...value, dateFrom: e.target.value }))}
            className="min-w-[8.5rem] flex-1 sm:w-38 sm:flex-none"
          />
          <span className="text-xs text-muted-foreground">até</span>
          <Input
            type="date"
            aria-label="Período (até)"
            value={value.dateTo}
            onChange={(e) => onChange(normalizeRange({ ...value, dateTo: e.target.value }))}
            className="min-w-[8.5rem] flex-1 sm:w-38 sm:flex-none"
          />
        </div>
      </div>
    </div>
  );
}
