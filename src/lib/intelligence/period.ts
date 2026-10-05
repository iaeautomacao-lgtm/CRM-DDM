// Período das ferramentas do Intelligence. Calendário de Brasília (UTC-3
// fixo, como monitoramento/day-view.ts), intervalo [from, to) com `to`
// exclusivo. Máximo de 92 dias para manter as consultas limitadas.

import { DAY_TZ_OFFSET, todayInBrazil } from "@/lib/monitoramento/day-view";
import { BadRequestError } from "./errors";
import type { Period } from "./types";

export const MAX_PERIOD_DAYS = 92;
const DAY_MS = 86_400_000;

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "previous_7_days",
  "last_30_days",
  "this_month",
  "last_month",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface PeriodInput {
  preset?: PeriodPreset;
  /** YYYY-MM-DD, inclusivo. */
  date_from?: string;
  /** YYYY-MM-DD, inclusivo. */
  date_to?: string;
}

const PRESET_LABEL: Record<PeriodPreset, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  last_7_days: "Últimos 7 dias",
  previous_7_days: "7 dias anteriores",
  last_30_days: "Últimos 30 dias",
  this_month: "Este mês",
  last_month: "Mês passado",
};

/** JSON Schema do período, reaproveitado pelas ferramentas. */
export const PERIOD_SCHEMA = {
  type: "object",
  description:
    "Período no horário de Brasília. Use `preset` OU `date_from`/`date_to` (YYYY-MM-DD, inclusivos). Máximo de 92 dias. Padrão: last_7_days.",
  properties: {
    preset: { type: "string", enum: [...PERIOD_PRESETS] },
    date_from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    date_to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  },
  additionalProperties: false,
} as const;

function isRealDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Meia-noite de Brasília do dia, em ms UTC. */
function startOfDayMs(date: string): number {
  return Date.parse(`${date}T00:00:00${DAY_TZ_OFFSET}`);
}

function fmt(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

function build(fromDate: string, toDateExclusive: string, label: string): Period {
  const fromMs = startOfDayMs(fromDate);
  const toMs = startOfDayMs(toDateExclusive);
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    label,
    days: Math.round((toMs - fromMs) / DAY_MS),
  };
}

function rangeLabel(fromDate: string, toDateExclusive: string): string {
  const last = addDays(toDateExclusive, -1);
  return fromDate === last ? fmt(fromDate) : `${fmt(fromDate)} a ${fmt(last)}`;
}

function presetRange(preset: PeriodPreset, today: string): [string, string] {
  const tomorrow = addDays(today, 1);
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "today":
      return [today, tomorrow];
    case "yesterday":
      return [addDays(today, -1), today];
    case "last_7_days":
      return [addDays(today, -6), tomorrow];
    case "previous_7_days":
      return [addDays(today, -13), addDays(today, -6)];
    case "last_30_days":
      return [addDays(today, -29), tomorrow];
    case "this_month":
      return [monthStart, tomorrow];
    case "last_month": {
      const prevMonthStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;
      return [prevMonthStart, monthStart];
    }
  }
}

/** Valida a forma crua (vinda do modelo) e devolve um PeriodInput tipado. */
export function validatePeriodInput(raw: unknown): PeriodInput {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("period deve ser um objeto");
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!["preset", "date_from", "date_to"].includes(k)) {
      throw new BadRequestError(`Campo não permitido em period: ${k}`);
    }
  }
  const out: PeriodInput = {};
  if (obj.preset !== undefined) {
    if (typeof obj.preset !== "string" || !(PERIOD_PRESETS as readonly string[]).includes(obj.preset)) {
      throw new BadRequestError(`period.preset inválido. Use um de: ${PERIOD_PRESETS.join(", ")}`);
    }
    out.preset = obj.preset as PeriodPreset;
  }
  for (const k of ["date_from", "date_to"] as const) {
    if (obj[k] !== undefined) {
      if (typeof obj[k] !== "string" || !isRealDate(obj[k] as string)) {
        throw new BadRequestError(`period.${k} deve ser uma data válida no formato YYYY-MM-DD`);
      }
      out[k] = obj[k] as string;
    }
  }
  return out;
}

/** Resolve o período. Sem nada informado: últimos 7 dias. */
export function resolvePeriod(input: PeriodInput = {}, nowMs = Date.now()): Period {
  const today = todayInBrazil(nowMs);
  const hasDates = input.date_from !== undefined || input.date_to !== undefined;
  if (input.preset && hasDates) {
    throw new BadRequestError("Use preset OU date_from/date_to, não os dois");
  }
  if (!hasDates) {
    const preset = input.preset ?? "last_7_days";
    const [from, to] = presetRange(preset, today);
    return build(from, to, `${PRESET_LABEL[preset]} (${rangeLabel(from, to)})`);
  }
  if (input.date_from === undefined) {
    throw new BadRequestError("period.date_from é obrigatório quando date_to é informado");
  }
  for (const d of [input.date_from, input.date_to]) {
    if (d !== undefined && !isRealDate(d)) {
      throw new BadRequestError("Datas do período devem estar no formato YYYY-MM-DD");
    }
  }
  const from = input.date_from;
  const to = addDays(input.date_to ?? today, 1);
  if (startOfDayMs(to) <= startOfDayMs(from)) {
    throw new BadRequestError("period.date_from deve ser anterior ou igual a date_to");
  }
  const days = Math.round((startOfDayMs(to) - startOfDayMs(from)) / DAY_MS);
  if (days > MAX_PERIOD_DAYS) {
    throw new BadRequestError(`Período máximo é de ${MAX_PERIOD_DAYS} dias (pedido: ${days})`);
  }
  return build(from, to, rangeLabel(from, to));
}

/** Período imediatamente anterior, com a mesma duração. */
export function previousPeriod(p: Period): Period {
  const fromMs = Date.parse(p.from);
  const len = Date.parse(p.to) - fromMs;
  const prevFrom = new Date(fromMs - len).toISOString();
  // Rótulo em datas de Brasília.
  const brDate = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);
  const fromDate = brDate(fromMs - len);
  const toDateExcl = brDate(fromMs);
  return {
    from: prevFrom,
    to: p.from,
    label: `Período anterior (${rangeLabel(fromDate, toDateExcl)})`,
    days: p.days,
  };
}

/** Dia (YYYY-MM-DD) de Brasília de um instante ISO. */
export function brazilDay(iso: string): string {
  return new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(0, 10);
}
