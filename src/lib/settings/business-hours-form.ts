// Ponte entre o formulário de horário de atendimento (Configurações › Organização) e o valor que a rota
// /api/settings/account-config grava (`business_hours`: { mon: [{start,end}], … }, dia ausente = sem atendimento).
// Puro: sem I/O, para testar sem tela.

export const WEEKDAYS = [
  { key: "mon", label: "Segunda-feira" },
  { key: "tue", label: "Terça-feira" },
  { key: "wed", label: "Quarta-feira" },
  { key: "thu", label: "Quinta-feira" },
  { key: "fri", label: "Sexta-feira" },
  { key: "sat", label: "Sábado" },
  { key: "sun", label: "Domingo" },
] as const;

export type WeekdayKey = (typeof WEEKDAYS)[number]["key"];
export interface HoursInterval {
  start: string;
  end: string;
}
export type HoursForm = Record<WeekdayKey, HoursInterval[]>;

export const MAX_INTERVALS_PER_DAY = 5;

export function emptyHoursForm(): HoursForm {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

/** Valor vindo da API (ou null = "sem horário definido") → formulário. Ignora o que não for intervalo bem formado. */
export function hoursToForm(value: unknown): HoursForm {
  const form = emptyHoursForm();
  if (!value || typeof value !== "object" || Array.isArray(value)) return form;
  const raw = value as Record<string, unknown>;
  for (const { key } of WEEKDAYS) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    form[key] = list
      .filter((i): i is HoursInterval => !!i && typeof i.start === "string" && typeof i.end === "string")
      .map((i) => ({ start: i.start, end: i.end }));
  }
  return form;
}

/** Formulário → valor da API: só os dias com intervalo (dia ausente = sem atendimento). */
export function formToHours(form: HoursForm): Record<string, HoursInterval[]> {
  const out: Record<string, HoursInterval[]> = {};
  for (const { key } of WEEKDAYS) {
    if (form[key].length > 0) out[key] = form[key].map((i) => ({ start: i.start, end: i.end }));
  }
  return out;
}

export function hoursFormEqual(a: HoursForm, b: HoursForm): boolean {
  return JSON.stringify(formToHours(a)) === JSON.stringify(formToHours(b));
}
