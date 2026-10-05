// Período único dos relatórios: atalhos (Hoje, 7 dias, Este mês…) e o
// período escolhido compartilhado entre as telas de Relatórios na mesma
// aba — trocar de Atendimentos para Conversas mantém o recorte.
//
// Datas no formato do <input type="date"> (yyyy-MM-dd, fuso do navegador),
// o mesmo que startOfDayIso/endOfDayIso (date-range.ts) já convertem.

import { endOfMonth, format, startOfMonth, subDays, subMonths } from "date-fns";

export interface PeriodRange {
  dateFrom: string;
  dateTo: string;
}

export type PeriodPreset = "hoje" | "ontem" | "7d" | "30d" | "mes" | "mes_passado";

export const PERIOD_PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: "hoje", label: "Hoje" },
  { id: "ontem", label: "Ontem" },
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "mes", label: "Este mês" },
  { id: "mes_passado", label: "Mês passado" },
];

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

export function presetRange(preset: PeriodPreset, now: Date = new Date()): PeriodRange {
  switch (preset) {
    case "hoje":
      return { dateFrom: ymd(now), dateTo: ymd(now) };
    case "ontem": {
      const y = subDays(now, 1);
      return { dateFrom: ymd(y), dateTo: ymd(y) };
    }
    case "7d":
      return { dateFrom: ymd(subDays(now, 6)), dateTo: ymd(now) };
    case "30d":
      return { dateFrom: ymd(subDays(now, 29)), dateTo: ymd(now) };
    case "mes":
      return { dateFrom: ymd(startOfMonth(now)), dateTo: ymd(now) };
    case "mes_passado": {
      const prev = subMonths(now, 1);
      return { dateFrom: ymd(startOfMonth(prev)), dateTo: ymd(endOfMonth(prev)) };
    }
  }
}

/** Qual atalho corresponde ao período (para destacar o botão), se algum. */
export function matchPreset(range: PeriodRange, now: Date = new Date()): PeriodPreset | null {
  for (const p of PERIOD_PRESETS) {
    const r = presetRange(p.id, now);
    if (r.dateFrom === range.dateFrom && r.dateTo === range.dateTo) return p.id;
  }
  return null;
}

/** "De" depois de "Até": troca as pontas em vez de buscar um período vazio. */
export function normalizeRange(range: PeriodRange): PeriodRange {
  if (range.dateFrom && range.dateTo && range.dateFrom > range.dateTo) {
    return { dateFrom: range.dateTo, dateTo: range.dateFrom };
  }
  return range;
}

const STORAGE_KEY = "relatorios:periodo";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Período escolhido por último em qualquer relatório desta aba. */
export function loadSharedPeriod(): PeriodRange | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PeriodRange>;
    if (typeof v.dateFrom === "string" && typeof v.dateTo === "string" && DATE_RE.test(v.dateFrom) && DATE_RE.test(v.dateTo)) {
      return { dateFrom: v.dateFrom, dateTo: v.dateTo };
    }
  } catch {
    // sessionStorage indisponível (aba privada, bloqueado) — sem memória.
  }
  return null;
}

export function saveSharedPeriod(range: PeriodRange): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(range));
  } catch {
    // idem
  }
}
