"use client";

import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { addDays, isBusinessDate, TIME_OPTIONS, weekdayOf } from "./wizard-rules";

// Data (calendário) + hora (seletor de 30 em 30 min), sempre no horário de
// Brasília. As datas trafegam como "AAAA-MM-DD" — nada de Date local do
// navegador, que dependeria do fuso de quem está usando. Sem dependência
// nova: grade do mês feita aqui, dentro do Popover do design system.

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const WEEKDAY_NAMES = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "2026-10-07" → "qua, 07/10/2026". */
export function formatDateLabel(date: string): string {
  const [y, m, d] = date.split("-");
  if (!y || !m || !d) return "Escolha a data";
  return `${WEEKDAY_NAMES[weekdayOf(date)]}, ${d}/${m}/${y}`;
}

function monthGrid(month: string): string[] {
  // month = "AAAA-MM"; grade começa no domingo da semana do dia 1.
  const first = `${month}-01`;
  const start = addDays(first, -weekdayOf(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

interface DatePickerProps {
  id: string;
  label: string;
  value: string;
  onChange: (date: string) => void;
  /** Primeira data permitida ("AAAA-MM-DD"). */
  min: string;
  /** Só segunda a sexta (o envio só acontece em dia útil). */
  businessDaysOnly?: boolean;
  invalid?: boolean;
}

export function DatePickerField({ id, label, value, onChange, min, businessDaysOnly = true, invalid }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState((value || min).slice(0, 7));
  const isDisabled = (date: string) => date < min || (businessDaysOnly && !isBusinessDate(date));

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setMonth((value || min).slice(0, 7));
        }}
      >
        <PopoverTrigger
          id={id}
          aria-invalid={invalid || undefined}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-lg border border-input bg-background px-3 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            invalid && "border-destructive"
          )}
        >
          <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1">{value ? formatDateLabel(value) : "Escolha a data"}</span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
              disabled={shiftMonth(month, -1) < min.slice(0, 7)}
              aria-label="Mês anterior"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <p className="text-sm font-medium capitalize" aria-live="polite">
              {MONTHS[Number(month.slice(5, 7)) - 1]} de {month.slice(0, 4)}
            </p>
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              aria-label="Próximo mês"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div role="grid" aria-label={`Calendário — ${label}`} className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAYS.map((d, i) => (
              <span key={i} role="columnheader" className="py-1 text-xs font-medium text-muted-foreground">
                {d}
              </span>
            ))}
            {monthGrid(month).map((date) => {
              const outside = date.slice(0, 7) !== month;
              const disabled = isDisabled(date);
              const selected = date === value;
              return (
                <button
                  key={date}
                  type="button"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={formatDateLabel(date)}
                  disabled={disabled}
                  onClick={() => {
                    onChange(date);
                    setOpen(false);
                  }}
                  className={cn(
                    "h-8 rounded-md text-xs transition-colors",
                    selected
                      ? "bg-primary font-semibold text-primary-foreground"
                      : "hover:bg-muted",
                    outside && !selected && "text-muted-foreground/60",
                    disabled && "cursor-not-allowed text-muted-foreground/40 line-through hover:bg-transparent"
                  )}
                >
                  {Number(date.slice(8, 10))}
                </button>
              );
            })}
          </div>
          {businessDaysOnly && (
            <p className="text-xs text-muted-foreground">Sábados e domingos ficam bloqueados: o envio é só em dia útil.</p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface TimeSelectProps {
  id: string;
  label: string;
  value: string;
  onChange: (time: string) => void;
  invalid?: boolean;
}

export function TimeSelectField({ id, label, value, onChange, invalid }: TimeSelectProps) {
  const options = TIME_OPTIONS.includes(value) ? TIME_OPTIONS : [...TIME_OPTIONS, value].sort();
  return (
    <div className="space-y-1">
      <label id={`${id}-label`} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger
          id={id}
          aria-labelledby={`${id}-label`}
          aria-invalid={invalid || undefined}
          className="h-9 w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {options.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
