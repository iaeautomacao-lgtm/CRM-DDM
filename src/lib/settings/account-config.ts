// PRD 19.3 / PRD 24, item 6 — registro das configurações da conta (wacrm.account_settings, migration 231).
//
// Cada chave tem tipo, rótulo, padrão e validador. Só FORMA é validada: o backend NÃO inventa valor de negócio (horário padrão, lista de
// eventos de notificação…) — sem linha no banco vale o padrão abaixo, e quem decide o conteúdo é o dono da conta na tela.
// Puro (sem I/O): usado pela rota e pelos testes.

export type SettingType = "timezone" | "business_hours" | "notification_preferences";

export type Validation = { ok: true; value: unknown } | { ok: false; error: string };

export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  /** Valor quando a conta não gravou nada. */
  default: unknown;
  /** Aceita `null` como valor gravado ("sem horário definido")? */
  nullable: boolean;
  validate: (value: unknown) => Validation;
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof DAYS)[number];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_INTERVALS_PER_DAY = 5;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function validateTimezone(value: unknown): Validation {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return { ok: false, error: "Informe um fuso IANA, ex.: America/Sao_Paulo" };
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value });
  } catch {
    return { ok: false, error: "Fuso desconhecido: use um nome IANA, ex.: America/Sao_Paulo" };
  }
  return { ok: true, value };
}

/** `{ mon: [{start:"08:00", end:"12:00"}, …], tue: […], … }` — dia ausente ou lista vazia = sem atendimento naquele dia. */
export function validateBusinessHours(value: unknown): Validation {
  if (!isPlainObject(value)) return { ok: false, error: "Horário de atendimento deve ser um objeto por dia da semana (mon…sun)" };
  const out: Record<string, Array<{ start: string; end: string }>> = {};
  for (const [day, raw] of Object.entries(value)) {
    if (!(DAYS as readonly string[]).includes(day)) return { ok: false, error: `Dia inválido "${day}" (use ${DAYS.join(", ")})` };
    if (!Array.isArray(raw) || raw.length > MAX_INTERVALS_PER_DAY) return { ok: false, error: `${day}: informe de 0 a ${MAX_INTERVALS_PER_DAY} intervalos` };
    const intervals: Array<{ start: string; end: string }> = [];
    for (const item of raw) {
      if (!isPlainObject(item) || typeof item.start !== "string" || typeof item.end !== "string" || !HHMM.test(item.start) || !HHMM.test(item.end)) {
        return { ok: false, error: `${day}: cada intervalo precisa de start e end no formato HH:MM` };
      }
      if (minutes(item.start) >= minutes(item.end)) return { ok: false, error: `${day}: o início deve ser antes do fim (${item.start}–${item.end})` };
      intervals.push({ start: item.start, end: item.end });
    }
    intervals.sort((a, b) => minutes(a.start) - minutes(b.start));
    for (let i = 1; i < intervals.length; i++) {
      if (minutes(intervals[i].start) < minutes(intervals[i - 1].end)) return { ok: false, error: `${day}: os intervalos não podem se sobrepor` };
    }
    out[day] = intervals;
  }
  return { ok: true, value: out };
}

const EVENT_KEY = /^[a-z][a-z0-9_.]{0,59}$/;
const CHANNELS = ["in_app", "email"] as const;
const MAX_EVENTS = 50;

/**
 * `{ "<evento>": { in_app?: boolean, email?: boolean } }`. O catálogo de eventos é do produto/front: aqui só se valida a forma
 * (nome do evento, canais conhecidos, booleanos), para não amarrar o backend a uma lista inventada.
 */
export function validateNotificationPreferences(value: unknown): Validation {
  if (!isPlainObject(value)) return { ok: false, error: "Preferências devem ser um objeto { evento: { in_app, email } }" };
  const entries = Object.entries(value);
  if (entries.length > MAX_EVENTS) return { ok: false, error: `No máximo ${MAX_EVENTS} eventos` };
  const out: Record<string, Record<string, boolean>> = {};
  for (const [event, raw] of entries) {
    if (!EVENT_KEY.test(event)) return { ok: false, error: `Nome de evento inválido: "${event.slice(0, 30)}"` };
    if (!isPlainObject(raw) || Object.keys(raw).length === 0) return { ok: false, error: `${event}: informe ao menos um canal (${CHANNELS.join(", ")})` };
    const channels: Record<string, boolean> = {};
    for (const [channel, flag] of Object.entries(raw)) {
      if (!(CHANNELS as readonly string[]).includes(channel)) return { ok: false, error: `${event}: canal desconhecido "${channel.slice(0, 20)}" (use ${CHANNELS.join(", ")})` };
      if (typeof flag !== "boolean") return { ok: false, error: `${event}.${channel} deve ser verdadeiro ou falso` };
      channels[channel] = flag;
    }
    out[event] = channels;
  }
  return { ok: true, value: out };
}

/** O fuso padrão é o que o sistema já usa hoje (janelas de envio em Brasília): não muda comportamento algum. */
export const ACCOUNT_SETTINGS: readonly SettingDef[] = [
  { key: "timezone", label: "Fuso horário da conta", type: "timezone", default: "America/Sao_Paulo", nullable: false, validate: validateTimezone },
  { key: "business_hours", label: "Horário de atendimento", type: "business_hours", default: null, nullable: true, validate: validateBusinessHours },
  { key: "notification_preferences", label: "Preferências de notificação", type: "notification_preferences", default: {}, nullable: false, validate: validateNotificationPreferences },
];

export function settingDef(key: string): SettingDef | null {
  return ACCOUNT_SETTINGS.find((s) => s.key === key) ?? null;
}

/** Valida o valor de uma chave do registro (null só onde o registro permite). */
export function validateSetting(def: SettingDef, value: unknown): Validation {
  if (value === null) return def.nullable ? { ok: true, value: null } : { ok: false, error: "Esta configuração não aceita vazio; use DELETE para voltar ao padrão" };
  return def.validate(value);
}

export interface SettingView {
  key: string;
  label: string;
  type: SettingType;
  value: unknown;
  source: "account" | "default";
  default: unknown;
  editable: boolean;
}

/** Junta o registro com o que a conta gravou. */
export function resolveSettings(stored: ReadonlyMap<string, unknown>, editable: boolean): SettingView[] {
  return ACCOUNT_SETTINGS.map((def) => {
    const has = stored.has(def.key);
    return { key: def.key, label: def.label, type: def.type, value: has ? stored.get(def.key) : def.default, source: has ? "account" : "default", default: def.default, editable };
  });
}
