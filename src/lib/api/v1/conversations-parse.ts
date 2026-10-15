// Controle do atendimento pela API pública (Onda 2) — validação PURA dos corpos de POST /conversations, /close e /transfer. Sem banco.
import { badRequest } from '@/lib/api/v1/respond';
import { DEFAULT_TEMPLATE_LANGUAGE, MAX_TEMPLATE_VARIABLES, MAX_VARIABLE_CHARS } from '@/lib/api/v1/templates';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_NUMBER_RE = /^\+?[0-9][0-9 ()-]{5,24}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/;
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
export const NOTE_MAX = 1000;
export const REASON_MAX = 500;
export const MESSAGE_TEXT_MAX = 4096;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function object(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Corpo da requisição deve ser um objeto JSON válido');
  return body as Record<string, unknown>;
}

function noUnknown(b: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw badRequest(`Campo(s) desconhecido(s): ${unknown.join(', ')}. Aceitos: ${allowed.join(', ')}`);
}

function optionalId(b: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in b) || b[key] === undefined) return undefined;
  if (b[key] === null) return null;
  if (!isUuid(b[key])) throw badRequest(`'${key}' deve ser um id (UUID)`);
  return b[key] as string;
}

function optionalText(b: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`'${key}' deve ser um texto`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`'${key}' aceita no máximo ${max} caracteres`);
  return t === '' ? undefined : t;
}

function bool(b: Record<string, unknown>, key: string): boolean {
  const v = b[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw badRequest(`'${key}' deve ser verdadeiro ou falso`);
  return v;
}

// ── transfer ─────────────────────────────────────────────────────────────────
export interface TransferInput {
  /** undefined = não mexer; null = remover o atendente. */
  assigneeId: string | null | undefined;
  teamId: string | null | undefined;
  confirmPaused: boolean;
  reason: string | undefined;
}

export function parseTransferBody(body: unknown): TransferInput {
  const b = object(body);
  noUnknown(b, ['assignee_id', 'team_id', 'confirm_paused', 'reason']);
  const out: TransferInput = { assigneeId: optionalId(b, 'assignee_id'), teamId: optionalId(b, 'team_id'), confirmPaused: bool(b, 'confirm_paused'), reason: optionalText(b, 'reason', REASON_MAX) };
  if (out.assigneeId === undefined && out.teamId === undefined) throw badRequest("Informe 'assignee_id' e/ou 'team_id' (null remove)");
  return out;
}

// ── close ────────────────────────────────────────────────────────────────────
export interface CloseInput {
  tabulationId: string | null;
  tabulationCode: number | null;
  note: string | undefined;
}

export function parseCloseBody(body: unknown): CloseInput {
  const b = object(body);
  noUnknown(b, ['tabulation_id', 'tabulation_code', 'note']);
  const id = optionalId(b, 'tabulation_id') ?? null;
  let code: number | null = null;
  if (b.tabulation_code !== undefined && b.tabulation_code !== null) {
    if (typeof b.tabulation_code !== 'number' || !Number.isInteger(b.tabulation_code) || b.tabulation_code < 0 || b.tabulation_code > 2_147_483_647) {
      throw badRequest("'tabulation_code' deve ser um número inteiro (código da tabulação; veja GET /tabulations)");
    }
    code = b.tabulation_code;
  }
  if (id === null && code === null) throw badRequest("Informe 'tabulation_code' (ou 'tabulation_id'); veja GET /tabulations");
  if (id !== null && code !== null) throw badRequest("Informe só um: 'tabulation_code' ou 'tabulation_id'");
  return { tabulationId: id, tabulationCode: code, note: optionalText(b, 'note', NOTE_MAX) };
}

// ── open ─────────────────────────────────────────────────────────────────────
export type InitialMessage =
  | { kind: 'text'; text: string }
  | { kind: 'template'; name: string; language: string; variables: string[] };

export interface OpenInput {
  phone: string | null;
  contactId: string | null;
  name: string | null;
  channel: string | null;
  assigneeId: string | null;
  teamId: string | null;
  forceTransfer: boolean;
  confirmPaused: boolean;
  reason: string | undefined;
  message: InitialMessage | null;
}

function parseMessage(raw: unknown): InitialMessage | null {
  if (raw === undefined || raw === null) return null;
  const m = object(raw);
  noUnknown(m, ['text', 'template']);
  const hasText = m.text !== undefined && m.text !== null;
  const hasTemplate = m.template !== undefined && m.template !== null;
  if (hasText === hasTemplate) throw badRequest("'message' deve ter 'text' OU 'template' (um dos dois)");
  if (hasText) {
    if (typeof m.text !== 'string' || m.text.trim() === '') throw badRequest("'message.text' deve ser um texto não vazio");
    if (m.text.length > MESSAGE_TEXT_MAX) throw badRequest(`'message.text' aceita no máximo ${MESSAGE_TEXT_MAX} caracteres`);
    return { kind: 'text', text: m.text };
  }
  const t = object(m.template);
  noUnknown(t, ['name', 'language', 'variables']);
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (!TEMPLATE_NAME_RE.test(name)) throw badRequest("'message.template.name' é obrigatório (letras minúsculas, números e _)");
  const language = t.language === undefined || t.language === null || t.language === '' ? DEFAULT_TEMPLATE_LANGUAGE : t.language;
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) throw badRequest("'message.template.language' inválido (ex.: pt_BR)");
  const rawVars = t.variables ?? [];
  if (!Array.isArray(rawVars)) throw badRequest("'message.template.variables' deve ser uma lista de textos");
  if (rawVars.length > MAX_TEMPLATE_VARIABLES) throw badRequest(`'variables' aceita no máximo ${MAX_TEMPLATE_VARIABLES} itens`);
  const variables = rawVars.map((v) => (typeof v === 'number' ? String(v) : v));
  if (!variables.every((v): v is string => typeof v === 'string')) throw badRequest("'variables' deve conter só textos");
  if (variables.some((v) => v.length > MAX_VARIABLE_CHARS || v.trim() === '')) throw badRequest(`Cada variável precisa de 1 a ${MAX_VARIABLE_CHARS} caracteres (não pode ser vazia)`);
  return { kind: 'template', name, language, variables };
}

export function parseOpenBody(body: unknown): OpenInput {
  const b = object(body);
  noUnknown(b, ['phone', 'to', 'contact_id', 'name', 'channel', 'assignee_id', 'team_id', 'force_transfer', 'confirm_paused', 'reason', 'message']);
  const phoneRaw = b.phone ?? b.to;
  const contactId = optionalId(b, 'contact_id') ?? null;
  const phone = typeof phoneRaw === 'string' && phoneRaw.trim() ? phoneRaw.trim() : null;
  if (phoneRaw !== undefined && phoneRaw !== null && phone === null) throw badRequest("'phone' deve ser um telefone (E.164, ex.: +5527999991212)");
  if (!phone && !contactId) throw badRequest("Informe 'phone' (E.164) ou 'contact_id'");
  if (phone && contactId) throw badRequest("Informe só um: 'phone' ou 'contact_id'");
  const assignee = optionalId(b, 'assignee_id');
  const team = optionalId(b, 'team_id');
  if (assignee === null || team === null) throw badRequest("Ao abrir, 'assignee_id' e 'team_id' não aceitam null (omita o campo)");
  let channel: string | null = null;
  if (b.channel !== undefined && b.channel !== null && b.channel !== '') {
    if (typeof b.channel !== 'string' || (!UUID_RE.test(b.channel.trim()) && !CHANNEL_NUMBER_RE.test(b.channel.trim()) && !/^[A-Za-z0-9_.-]{1,80}$/.test(b.channel.trim()))) {
      throw badRequest("'channel' deve ser o id (UUID), o número do canal Meta ou a sessão WAHA");
    }
    channel = b.channel.trim();
  }
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : null;
  return {
    phone,
    contactId,
    name,
    channel,
    assigneeId: assignee ?? null,
    teamId: team ?? null,
    forceTransfer: bool(b, 'force_transfer'),
    confirmPaused: bool(b, 'confirm_paused'),
    reason: optionalText(b, 'reason', REASON_MAX),
    message: parseMessage(b.message),
  };
}
