"use client";

// Seletor de período único dos Relatórios: atalhos + De/Até. Só altera o
// rascunho do filtro — cada tela continua aplicando com o próprio botão.

import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ddm/segmented";
import {
  PERIOD_PRESETS,
  matchPreset,
  presetRange,
  rangeError,
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
  const error = rangeError(value);
  const errorId = useId();
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
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Período (de)"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={value.dateFrom}
            onChange={(e) => onChange({ ...value, dateFrom: e.target.value })}
            className="w-38"
          />
          <span className="text-xs text-muted-foreground">até</span>
          <Input
            type="date"
            aria-label="Período (até)"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={value.dateTo}
            onChange={(e) => onChange({ ...value, dateTo: e.target.value })}
            className="w-38"
          />
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
