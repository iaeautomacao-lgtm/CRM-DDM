// Regras puras da criação de campanha pela API pública
// (POST /api/v1/disparador/campaigns). A rota NÃO usa startCampaign() de
// propósito (contatos externos, sem import_draft_id); aqui ficam só os
// helpers testáveis que a paridade com a tela exige: validação de janela,
// normalização/dedupe/validação de contatos, variáveis WAHA e agendamento
// pelo relógio de janela.

import { createHash } from "node:crypto";
import { phoneKey } from "@/lib/disparador/phone-key";
import { BUSINESS_DAYS } from "@/lib/disparador/campaign-validation";
import { addOpenWindowTime, roundSpreadOffsetMs } from "@/lib/disparador/window-clock";

/** Teto de contatos por requisição. */
export const MAX_CONTACTS_PER_REQUEST = 20_000;
/** Teto do corpo (bytes/caracteres) lido antes do JSON.parse. */
export const MAX_BODY_BYTES = 15 * 1024 * 1024;
/** Quantidade máxima de contatos inválidos devolvidos como amostra. */
export const INVALID_SAMPLE_LIMIT = 20;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type InvalidReason =
  | "invalid_contact"
  | "missing_phone"
  | "invalid_phone"
  | "missing_variable";

export interface InvalidSample {
  index: number;
  phone: string | null;
  reason: InvalidReason;
}

export interface ApiContactInput {
  phone: unknown;
  variables?: unknown;
}

export interface NormalizedContact {
  index: number;
  phone: string;
  variables: string[];
}

export interface NormalizeResult {
  contacts: NormalizedContact[];
  duplicates: number;
  /** Na blacklist (mesma regra do startCampaign: phoneKey). */
  skipped: number;
  invalid: number;
  invalidSample: InvalidSample[];
}

/** Janela HH:MM com fim > início (igual à tela). Devolve mensagem de erro ou null. */
export function validateApiWindow(inicio: unknown, fim: unknown): string | null {
  if (typeof inicio !== "string" || typeof fim !== "string" || !HHMM.test(inicio) || !HHMM.test(fim)) {
    return "'janela_inicio' e 'janela_fim' devem estar no formato HH:MM (ex.: 08:00)";
  }
  if (fim <= inicio) {
    return "'janela_fim' deve ser depois de 'janela_inicio' (o envio acontece dentro do mesmo dia)";
  }
  return null;
}

/** Dias da semana (0=dom … 6=sáb). Padrão da tela: dias úteis. */
export function resolveApiDays(input: unknown): { days: number[] } | { error: string } {
  if (input == null) return { days: [...BUSINESS_DAYS] };
  if (!Array.isArray(input) || input.length === 0 || input.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { error: "'dias_envio' deve ser uma lista de inteiros 0–6 (0 = domingo)" };
  }
  return { days: [...new Set(input as number[])].sort((a, b) => a - b) };
}

/** Dígitos do telefone, ou null se inválido (7–15 dígitos; BR com 55 = 12–13). */
export function validateApiPhone(raw: unknown): { digits: string } | { reason: "missing_phone" | "invalid_phone" } {
  if (typeof raw !== "string" && typeof raw !== "number") return { reason: "missing_phone" };
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return { reason: "missing_phone" };
  if (!/^[1-9]\d{6,14}$/.test(digits)) return { reason: "invalid_phone" };
  if (digits.startsWith("55") && (digits.length < 12 || digits.length > 13)) return { reason: "invalid_phone" };
  return { digits };
}

const PLACEHOLDER = /\{\{(\d+)\}\}/g;

/** Índices (1-based) dos placeholders {{n}} do texto. */
export function placeholderIndexes(message: string): number[] {
  const found = new Set<number>();
  for (const m of message.matchAll(PLACEHOLDER)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * WAHA: passada única, sem reinterpretar `$&`/`$1` nem placeholders que
 * venham dentro de um valor. Devolve null se algum {{n}} ficar sem valor
 * (nunca deixa {{n}} literal chegar ao cliente).
 */
export function resolveWahaMessage(message: string, variables: readonly string[]): string | null {
  let missing = false;
  const text = message.replace(PLACEHOLDER, (_whole, n: string) => {
    const value = variables[Number(n) - 1];
    if (value === undefined || value === "") {
      missing = true;
      return "";
    }
    return String(value);
  });
  return missing ? null : text;
}

function normalizeVariables(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v)));
}

/**
 * Valida, deduplica (phoneKey: com/sem 55, com/sem 9º dígito) e filtra a
 * blacklist. Ordem preservada; o primeiro de cada chave vale.
 */
export function normalizeApiContacts(
  contacts: readonly unknown[],
  options: { blacklist: ReadonlySet<string>; wahaMessage?: string | null; metaBodyVariables?: number }
): NormalizeResult {
  const out: NormalizedContact[] = [];
  const seen = new Set<string>();
  const invalidSample: InvalidSample[] = [];
  let invalid = 0;
  let duplicates = 0;
  let skipped = 0;
  const required =
    options.wahaMessage != null
      ? placeholderIndexes(options.wahaMessage)
      : Array.from({ length: Math.max(0, options.metaBodyVariables ?? 0) }, (_, k) => k + 1);

  const reject = (index: number, phone: string | null, reason: InvalidReason) => {
    invalid++;
    if (invalidSample.length < INVALID_SAMPLE_LIMIT) invalidSample.push({ index, phone, reason });
  };

  contacts.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      reject(index, null, "invalid_contact");
      return;
    }
    const contact = entry as ApiContactInput;
    const phone = validateApiPhone(contact.phone);
    const shown = typeof contact.phone === "string" || typeof contact.phone === "number" ? String(contact.phone) : null;
    if ("reason" in phone) {
      reject(index, shown, phone.reason);
      return;
    }
    const variables = normalizeVariables(contact.variables);
    if (required.some((n) => variables[n - 1] === undefined || variables[n - 1] === "")) {
      reject(index, shown, "missing_variable");
      return;
    }
    const key = phoneKey(phone.digits);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    if (options.blacklist.has(key)) {
      skipped++;
      return;
    }
    out.push({ index, phone: phone.digits, variables });
  });

  return { contacts: out, duplicates, skipped, invalid, invalidSample };
}

/**
 * scheduled_at de cada contato: slot k abre `k × intervalo` de tempo ABERTO
 * da janela depois da 1ª abertura (relógio de janela, igual ao startCampaign:
 * o que passa do horário continua no próximo dia permitido, mantendo o
 * espaçamento) + o mesmo espalhamento curto da rodada.
 */
export function scheduleApiContacts(
  total: number,
  options: {
    now: Date;
    slotSize: number;
    slotIntervalMs: number;
    janela: { inicio: string; fim: string; dias: number[] };
  }
): Date[] {
  const slotSize = Math.max(1, Math.floor(options.slotSize));
  const slotCount = Math.ceil(total / slotSize);
  const slotTimes: Date[] = [];
  for (let k = 0; k < slotCount; k++) {
    slotTimes.push(addOpenWindowTime(options.now, k * options.slotIntervalMs, options.janela));
  }
  const times: Date[] = [];
  for (let i = 0; i < total; i++) {
    const slot = Math.floor(i / slotSize);
    const size = Math.min(slotSize, total - slot * slotSize);
    times.push(new Date(slotTimes[slot].getTime() + roundSpreadOffsetMs(i % slotSize, size)));
  }
  return times;
}

/** JSON com chaves ordenadas — hash estável do conteúdo da requisição. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Chave de idempotência efetiva (external_id vence o header) e hash do conteúdo. */
export function resolveIdempotency(
  headerKey: string | null,
  externalId: unknown,
  body: unknown
): { key: string | null; hash: string; error?: string } {
  const hash = createHash("sha256").update(stableStringify(body)).digest("hex");
  if (externalId != null && (typeof externalId !== "string" || !/^[A-Za-z0-9._:\-/]{1,128}$/.test(externalId))) {
    return { key: null, hash, error: "'external_id' deve ter até 128 caracteres (letras, números, . _ : - /)" };
  }
  if (typeof externalId === "string" && externalId) return { key: `ext:${externalId}`, hash };
  if (headerKey != null && headerKey !== "") {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(headerKey)) {
      return { key: null, hash, error: "'Idempotency-Key' deve ter 8–128 caracteres (letras, números, . _ : -)" };
    }
    return { key: `idem:${headerKey}`, hash };
  }
  return { key: null, hash };
}
