// Validação manual do input das ferramentas (o projeto não usa zod).
// Mensagens em pt-BR, pensadas para o modelo corrigir a chamada.

import { BadRequestError } from "../errors";
import { type PeriodInput, resolvePeriod, validatePeriodInput } from "../period";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("O input da ferramenta deve ser um objeto JSON");
  }
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new BadRequestError(
        `Campo não permitido: ${k}. Campos aceitos: ${allowed.length ? allowed.join(", ") : "(nenhum)"}`,
      );
    }
  }
  return obj;
}

export function optUuid(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new BadRequestError(`${key} deve ser um UUID`);
  return v.toLowerCase();
}

export function reqUuid(obj: Record<string, unknown>, key: string): string {
  const v = optUuid(obj, key);
  if (v === undefined) throw new BadRequestError(`${key} é obrigatório`);
  return v;
}

export function optEnum<T extends string>(obj: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new BadRequestError(`${key} inválido. Use um de: ${values.join(", ")}`);
  }
  return v as T;
}

export function reqEnum<T extends string>(obj: Record<string, unknown>, key: string, values: readonly T[]): T {
  const v = optEnum(obj, key, values);
  if (v === undefined) throw new BadRequestError(`${key} é obrigatório. Use um de: ${values.join(", ")}`);
  return v;
}

export function optBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new BadRequestError(`${key} deve ser true ou false`);
  return v;
}

export function optInt(obj: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BadRequestError(`${key} deve ser um inteiro entre ${min} e ${max}`);
  }
  return v;
}

/**
 * Valida o campo `period` (padrão: últimos 7 dias). Já resolve uma vez
 * para recusar período invertido/longo na validação; o run resolve de
 * novo com o relógio do contexto.
 */
export function periodField(obj: Record<string, unknown>): PeriodInput {
  const input = validatePeriodInput(obj.period);
  resolvePeriod(input);
  return input;
}

export const CHANNEL_TYPES = ["whatsapp", "webchat", "instagram", "messenger", "sms"] as const;
export const CONVERSATION_STATUSES = ["open", "pending", "closed"] as const;
