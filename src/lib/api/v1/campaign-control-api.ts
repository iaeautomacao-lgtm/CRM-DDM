// API pública v1 — controle de campanha (pausar, retomar, cancelar) e remoção de destinatários. Camada fina sobre
// src/lib/disparador/campaign-control.ts: lê/valida o corpo, traduz o resultado de negócio para o envelope de erros da API e cuida do
// limite de 30/min por chave. Desenho: prd-v2/api-onda1-desenho.md.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest, notFound, rateLimited } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { phoneKey } from '@/lib/disparador/phone-key';
import { validateApiPhone, normalizeReference } from '@/lib/disparador/api-v1-campaign';
import { parseCpf } from '@/lib/contacts/contact-api';
import type { ControlFailure } from '@/lib/disparador/campaign-control';
import { REMOVE_MAX_RECIPIENTS, REMOVE_REASONS, type RemoveEntryStatus, type RemoveReason } from '@/lib/api/v1/campaign-api-constants';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;


/** 30/min por chave nas ações que mexem na fila (além dos 120/min gerais). */
export async function enforceControlRateLimit(ctx: { keyId: string; accountId: string }): Promise<void> {
  const result = await checkRateLimit(`api-v1-campaign-control:${ctx.keyId}`, RATE_LIMITS.apiV1CampaignControl);
  if (!result.success) throw rateLimited(result, { accountId: ctx.accountId, keyId: ctx.keyId });
}

/** Corpo JSON opcional: vazio = {}; JSON inválido ou não-objeto = 400. */
export async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Corpo da requisição não é um JSON válido');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('Corpo da requisição deve ser um objeto JSON');
  return parsed as Record<string, unknown>;
}

export function parsePauseBody(body: Record<string, unknown>): { reason: string | null } {
  const reason = body.reason;
  if (reason === undefined || reason === null || reason === '') return { reason: null };
  if (typeof reason !== 'string' || reason.trim().length > 200) throw badRequest("'reason' deve ser um texto de até 200 caracteres");
  return { reason: reason.trim() };
}

export function parseResumeBody(body: Record<string, unknown>): { acknowledgeAutoPause: boolean } {
  const ack = body.acknowledge_auto_pause;
  if (ack !== undefined && typeof ack !== 'boolean') throw badRequest("'acknowledge_auto_pause' deve ser true ou false");
  return { acknowledgeAutoPause: ack === true };
}

/** Cancelar é irreversível: exige `confirm: true`. */
export function parseCancelBody(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw badRequest("Cancelar é irreversível: envie { \"confirm\": true } para confirmar");
}

/** Falha de negócio → ApiError. Conflito e bloqueio saem como 409 `conflict`, com `error.details.code` quando houver. */
export function controlFailureToApiError(failure: ControlFailure): ApiError {
  switch (failure.kind) {
    case 'not_found':
      return notFound(failure.message);
    case 'conflict':
    case 'blocked':
      return new ApiError('conflict', failure.message, 409, undefined, undefined, { details: failure.details });
    default:
      return new ApiError('internal', failure.message, 500);
  }
}

// ── Remover destinatários ──────────────────────────────────────────────────

export interface ParsedRemoveEntry {
  index: number;
  phoneKey: string | null;
  cpf: string | null;
  reference: string | null;
  invalid: string | null;
}

export interface ParsedRemoveBody {
  reason: RemoveReason;
  entries: ParsedRemoveEntry[];
}

export function parseRemoveBody(body: Record<string, unknown>): ParsedRemoveBody {
  const list = body.recipients;
  if (!Array.isArray(list) || list.length === 0) throw badRequest("'recipients' é obrigatório e não pode ser vazio");
  if (list.length > REMOVE_MAX_RECIPIENTS) throw badRequest(`Máximo de ${REMOVE_MAX_RECIPIENTS} destinatários por chamada (recebido: ${list.length})`);
  const reasonRaw = body.reason ?? 'other';
  if (typeof reasonRaw !== 'string' || !(REMOVE_REASONS as readonly string[]).includes(reasonRaw)) {
    throw badRequest(`'reason' inválido. Use: ${REMOVE_REASONS.join(', ')}`);
  }
  const entries: ParsedRemoveEntry[] = list.map((raw, index) => {
    const entry: ParsedRemoveEntry = { index, phoneKey: null, cpf: null, reference: null, invalid: null };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...entry, invalid: 'Item deve ser um objeto' };
    const r = raw as { phone?: unknown; cpf?: unknown; reference?: unknown };
    if (r.phone !== undefined && r.phone !== null && r.phone !== '') {
      const phone = validateApiPhone(r.phone);
      if ('reason' in phone) return { ...entry, invalid: "'phone' inválido (use DDI + DDD + número)" };
      entry.phoneKey = phoneKey(phone.digits);
    }
    if (r.cpf !== undefined && r.cpf !== null && r.cpf !== '') {
      const cpf = parseCpf(r.cpf);
      if (!cpf.ok || !cpf.value) return { ...entry, invalid: "'cpf' inválido" };
      entry.cpf = cpf.value;
    }
    if (r.reference !== undefined && r.reference !== null && r.reference !== '') {
      const reference = normalizeReference(r.reference);
      if (reference === false || reference === null) return { ...entry, invalid: "'reference' inválida (até 64 caracteres)" };
      entry.reference = reference;
    }
    if (!entry.phoneKey && !entry.cpf && !entry.reference) return { ...entry, invalid: "Informe 'phone', 'cpf' ou 'reference'" };
    return entry;
  });
  return { reason: reasonRaw as RemoveReason, entries };
}

/** CPF (só dígitos) → chaves de telefone (contacts.phone + contact_phones) dos contatos da conta com esse CPF. */
export async function phoneKeysForCpfs(db: Db, accountId: string, cpfs: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const unique = [...new Set(cpfs)];
  if (unique.length === 0) return out;
  const { data: contacts, error } = await db.from('contacts').select('id, phone, cpf').eq('account_id', accountId).in('cpf', unique);
  if (error) throw error;
  const rows = (contacts ?? []) as Array<{ id: string; phone: string | null; cpf: string }>;
  const ids = rows.map((c) => c.id);
  const extra = new Map<string, string[]>();
  if (ids.length > 0) {
    const { data: phones, error: phonesError } = await db.from('contact_phones').select('contact_id, phone').in('contact_id', ids);
    if (phonesError) throw phonesError;
    for (const p of (phones ?? []) as Array<{ contact_id: string; phone: string }>) {
      extra.set(p.contact_id, [...(extra.get(p.contact_id) ?? []), p.phone]);
    }
  }
  for (const c of rows) {
    const keys = [c.phone, ...(extra.get(c.id) ?? [])].filter((p): p is string => !!p).map((p) => phoneKey(p)).filter(Boolean);
    out.set(c.cpf, [...new Set([...(out.get(c.cpf) ?? []), ...keys])]);
  }
  return out;
}

interface RpcState {
  status: Exclude<RemoveEntryStatus, 'invalid'>;
  items: number;
}
interface RpcResult {
  removed: number;
  phones: Record<string, RpcState>;
  references: Record<string, RpcState>;
}

const PRIORITY: RemoveEntryStatus[] = ['removed', 'in_flight', 'already_removed', 'already_sent', 'not_found'];

/** Junta os estados de vários identificadores do mesmo item (telefone, CPF→telefones, referência): vence o de maior prioridade. */
export function combineStatuses(states: readonly RpcState[]): RpcState {
  if (states.length === 0) return { status: 'not_found', items: 0 };
  let best = states[0].status;
  for (const s of states) if (PRIORITY.indexOf(s.status) < PRIORITY.indexOf(best)) best = s.status;
  return { status: best, items: states.reduce((n, s) => n + s.items, 0) };
}

export interface RemoveResponse {
  results: Array<{ index: number; status: RemoveEntryStatus; items: number; message?: string }>;
  items_removed: number;
  removed: number;
  already_removed: number;
  in_flight: number;
  already_sent: number;
  not_found: number;
  invalid: number;
}

/** Executa a remoção. `null` = campanha inexistente/de outra conta (404). Sem a RPC (migration 357) = 503. */
export async function removeRecipients(db: Db, input: { accountId: string; campaignId: string; parsed: ParsedRemoveBody }): Promise<RemoveResponse | null> {
  const { parsed } = input;
  const valid = parsed.entries.filter((e) => !e.invalid);
  const cpfKeys = await phoneKeysForCpfs(db, input.accountId, valid.map((e) => e.cpf).filter((c): c is string => !!c));
  const phoneKeysList = new Set<string>();
  const references = new Set<string>();
  for (const e of valid) {
    if (e.phoneKey) phoneKeysList.add(e.phoneKey);
    if (e.reference) references.add(e.reference);
    if (e.cpf) for (const k of cpfKeys.get(e.cpf) ?? []) phoneKeysList.add(k);
  }

  let rpc: RpcResult = { removed: 0, phones: {}, references: {} };
  if (phoneKeysList.size > 0 || references.size > 0) {
    const { data, error } = await db.rpc('remove_campaign_recipients', {
      p_account: input.accountId,
      p_campaign: input.campaignId,
      p_phone_keys: [...phoneKeysList],
      p_references: [...references],
      p_reason: parsed.reason,
    });
    if (error) {
      if (error.code === '42883' || error.code === 'PGRST202' || /does not exist|schema cache/i.test(error.message)) {
        throw new ApiError('unavailable', 'Remoção de destinatários indisponível: aplique a migration 357', 503);
      }
      throw error;
    }
    if (data === null || data === undefined) return null;
    rpc = data as RpcResult;
  } else {
    // Só CPFs sem contato (ou entradas inválidas): nada a procurar na fila, mas a campanha tem de ser da conta.
    const { data, error } = await db.from('campaigns').select('id').eq('id', input.campaignId).eq('account_id', input.accountId).limit(1);
    if (error) throw error;
    if (!data?.[0]) return null;
  }

  const results: RemoveResponse['results'] = parsed.entries.map((e) => {
    if (e.invalid) return { index: e.index, status: 'invalid', items: 0, message: e.invalid };
    const states: RpcState[] = [];
    if (e.phoneKey) states.push(rpc.phones[e.phoneKey] ?? { status: 'not_found', items: 0 });
    if (e.reference) states.push(rpc.references[e.reference] ?? { status: 'not_found', items: 0 });
    if (e.cpf) {
      const keys = cpfKeys.get(e.cpf) ?? [];
      states.push(keys.length === 0 ? { status: 'not_found', items: 0 } : combineStatuses(keys.map((k) => rpc.phones[k] ?? { status: 'not_found', items: 0 })));
    }
    const merged = combineStatuses(states);
    return { index: e.index, status: merged.status, items: merged.items };
  });
  const count = (s: RemoveEntryStatus) => results.filter((r) => r.status === s).length;
  return {
    results,
    items_removed: Number(rpc.removed) || 0,
    removed: count('removed'),
    already_removed: count('already_removed'),
    in_flight: count('in_flight'),
    already_sent: count('already_sent'),
    not_found: count('not_found'),
    invalid: count('invalid'),
  };
}
