// ============================================================
// API v1 — extração de conversas e mensagens (TASK38). Só leitura, escopo da conta da chave em TODA consulta.
//
// Fora por regra: chat interno entre operadores, notas internas, dados de prompt/decisão da IA e dados sensíveis do contato
// (CPF e afins: o contato sai só como { id, name, phone }). A mídia sai SEM URL, a menos que o chamador peça
// (include_media_urls=true) — e então com URL assinada de 15 min.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError, badRequest, rateLimited } from '@/lib/api/v1/respond';
import { chatMediaPath } from '@/lib/storage/chat-media';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export const EXTRACT_DEFAULT_CONVERSATIONS = 100;
export const EXTRACT_MAX_CONVERSATIONS = 500;
export const EXTRACT_DEFAULT_MESSAGES = 500;
export const EXTRACT_MAX_MESSAGES = 1000;
export const EXTRACT_MAX_PERIOD_DAYS = 31;
export const MEDIA_URL_TTL_SECONDS = 15 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_RE = /^[a-z][a-z_]{1,19}$/;

export const isUuid = (v: string | null | undefined): v is string => !!v && UUID_RE.test(v);

/** 60 req/min por chave nas três rotas de extração (429 + Retry-After), além do limite geral da API. */
export async function enforceExtractRateLimit(ctx: { keyId: string; accountId: string }): Promise<void> {
  const result = await checkRateLimit(`apikey-extract:${ctx.keyId}`, RATE_LIMITS.apiV1Extract);
  if (!result.success) throw rateLimited(result, { accountId: ctx.accountId, keyId: ctx.keyId });
}

export function parseLimit(raw: string | null, def: number, max: number): number {
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("'limit' deve ser um inteiro maior ou igual a 1");
  return Math.min(n, max);
}

export function parseIso(raw: string | null, name: string): string | null {
  if (raw === null || raw === '') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw badRequest(`'${name}' deve ser uma data ISO 8601`);
  return new Date(ms).toISOString();
}

export function parseChannel(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  if (!CHANNEL_RE.test(raw)) throw badRequest("'channel' inválido");
  return raw;
}

export function parseUuidParam(raw: string | null, name: string): string | null {
  if (raw === null || raw === '') return null;
  if (!UUID_RE.test(raw)) throw badRequest(`'${name}' deve ser um UUID`);
  return raw;
}

export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(raw: string | null, arity: number): string[] | null {
  if (raw === null || raw === '') return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === arity && v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 80)) return v;
  } catch {
    /* cai no erro abaixo */
  }
  throw badRequest("'cursor' inválido");
}

// ── Mensagens ──────────────────────────────────────────────────────────────

export type AuthorType = 'customer' | 'operator' | 'ai' | 'flow' | 'campaign' | 'automation' | 'api';
const AUTHOR_TYPES: readonly string[] = ['customer', 'operator', 'ai', 'flow', 'campaign', 'automation', 'api'];

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number | string;
  created_at: string;
  sender_type: string;
  sender_id: string | null;
  origin: string | null;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  status: string | null;
  reply_to_message_id: string | null;
  campaign_id: string | null;
  contact_id: string | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  seq: number;
  created_at: string;
  direction: 'inbound' | 'outbound';
  author: { type: AuthorType; id: string | null; name: string | null };
  content_type: string;
  text: string | null;
  template: { name: string; variables: null } | null;
  media: { type: string; mime: string | null; filename: string | null; size: number | null; url?: string } | null;
  status: string | null;
  reply_to_id: string | null;
  campaign_id: string | null;
}

/** Origem da mensagem: NULL (histórico antigo, anterior à migration 302) vira 'automation', exceto cliente e atendente identificado. */
export function authorTypeOf(row: Pick<MessageRow, 'origin' | 'sender_type' | 'sender_id'>): AuthorType {
  if (row.origin && AUTHOR_TYPES.includes(row.origin)) return row.origin as AuthorType;
  if (row.sender_type === 'customer') return 'customer';
  if (row.sender_type === 'agent' && row.sender_id) return 'operator';
  return 'automation';
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
  pdf: 'application/pdf', doc: 'application/msword', xls: 'application/vnd.ms-excel', csv: 'text/csv', txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Descritor da mídia SEM URL. A mensagem não guarda mime/nome/tamanho: mime e nome vêm do caminho do arquivo; size = null. */
export function mediaDescriptor(row: Pick<MessageRow, 'media_url' | 'content_type'>): ApiMessage['media'] {
  if (!row.media_url) return null;
  const clean = row.media_url.split('?')[0];
  let name: string | null = null;
  try {
    name = decodeURIComponent(clean.split('/').filter(Boolean).pop() ?? '') || null;
  } catch {
    name = null;
  }
  const ext = name && name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return { type: row.content_type, mime: MIME_BY_EXT[ext] ?? null, filename: name, size: null };
}

export interface MessageLookups {
  agents: Map<string, string>;
  contacts: Map<string, string | null>;
  signedUrls: Map<string, string>;
}

export function toApiMessage(row: MessageRow, lookups: MessageLookups): ApiMessage {
  const type = authorTypeOf(row);
  let author: ApiMessage['author'] = { type, id: null, name: null };
  if (type === 'operator' && row.sender_id) author = { type, id: row.sender_id, name: lookups.agents.get(row.sender_id) ?? null };
  else if (type === 'customer' && row.contact_id) author = { type, id: row.contact_id, name: lookups.contacts.get(row.contact_id) ?? null };

  const media = mediaDescriptor(row);
  if (media && row.media_url) {
    const url = lookups.signedUrls.get(row.media_url);
    if (url) media.url = url;
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    seq: Number(row.seq),
    created_at: new Date(row.created_at).toISOString(),
    direction: row.sender_type === 'customer' ? 'inbound' : 'outbound',
    author,
    content_type: row.content_type,
    text: row.content_text,
    // As variáveis do template não são gravadas na mensagem (só o nome); o texto já renderizado, quando existe, vai em `text`.
    template: row.template_name ? { name: row.template_name, variables: null } : null,
    media,
    status: row.status,
    reply_to_id: row.reply_to_message_id,
    campaign_id: row.campaign_id,
  };
}

type Db = SupabaseClient;

/** Nomes dos atendentes e contatos das mensagens da página (consultas em lote, sempre com o account_id da chave). */
async function loadAuthors(db: Db, accountId: string, rows: MessageRow[]): Promise<Pick<MessageLookups, 'agents' | 'contacts'>> {
  const agents = new Map<string, string>();
  const contacts = new Map<string, string | null>();
  const agentIds = [...new Set(rows.filter((r) => authorTypeOf(r) === 'operator' && r.sender_id).map((r) => r.sender_id as string))];
  const contactIds = [...new Set(rows.filter((r) => authorTypeOf(r) === 'customer' && r.contact_id).map((r) => r.contact_id as string))];
  if (agentIds.length > 0) {
    const { data, error } = await db.from('profiles').select('user_id, full_name').eq('account_id', accountId).in('user_id', agentIds);
    if (error) throw error;
    for (const p of (data ?? []) as Array<{ user_id: string; full_name: string }>) agents.set(p.user_id, p.full_name);
  }
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data, error } = await db.from('contacts').select('id, name').eq('account_id', accountId).in('id', contactIds.slice(i, i + 200));
    if (error) throw error;
    for (const c of (data ?? []) as Array<{ id: string; name: string | null }>) contacts.set(c.id, c.name);
  }
  return { agents, contacts };
}

/** URLs assinadas de 15 min, só quando pedido. URL externa (de terceiro) não é nossa para assinar: vai como está. */
async function signMedia(db: Db, rows: MessageRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byPath = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.media_url) continue;
    const path = chatMediaPath(r.media_url);
    if (!path) {
      if (/^https:\/\//i.test(r.media_url)) out.set(r.media_url, r.media_url);
      continue;
    }
    byPath.set(path, [...(byPath.get(path) ?? []), r.media_url]);
  }
  const paths = [...byPath.keys()];
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { data, error } = await db.storage.from('chat-media').createSignedUrls(chunk, MEDIA_URL_TTL_SECONDS);
    if (error) throw error;
    for (const item of (data ?? []) as Array<{ path: string | null; signedUrl: string | null }>) {
      if (!item.path || !item.signedUrl) continue;
      for (const original of byPath.get(item.path) ?? []) out.set(original, item.signedUrl);
    }
  }
  return out;
}

const isMissingFunction = (e: { code?: string; message?: string }) =>
  e.code === 'PGRST202' || e.code === '42883' || /could not find the function|does not exist/i.test(e.message ?? '');

export interface MessagePageOptions {
  accountId: string;
  conversationId?: string | null;
  from?: string | null;
  to?: string | null;
  channel?: string | null;
  teamId?: string | null;
  cursor: string[] | null; // [created_at, id]
  limit: number;
  includeMediaUrls: boolean;
}

/** Uma página de mensagens em ordem (created_at, id) ascendente, com seq, autor e mídia. `next_cursor` = null no fim. */
export async function loadMessagePage(db: Db, opts: MessagePageOptions): Promise<{ items: ApiMessage[]; next_cursor: string | null }> {
  const { data, error } = await db.rpc('api_v1_messages', {
    p_account_id: opts.accountId,
    p_conversation_id: opts.conversationId ?? null,
    p_from: opts.from ?? null,
    p_to: opts.to ?? null,
    p_after_at: opts.cursor?.[0] ?? null,
    p_after_id: opts.cursor?.[1] ?? null,
    p_channel: opts.channel ?? null,
    p_team_id: opts.teamId ?? null,
    // Uma a mais que a página: acusa "tem mais" sem COUNT.
    p_limit: Math.min(opts.limit + 1, EXTRACT_MAX_MESSAGES + 1),
  });
  if (error) {
    if (isMissingFunction(error)) throw new ApiError('unavailable', 'Extração de mensagens indisponível: aplique a migration 330.', 503);
    throw error;
  }
  const all = (data ?? []) as MessageRow[];
  const rows = all.slice(0, opts.limit);
  const authors = await loadAuthors(db, opts.accountId, rows);
  const signedUrls = opts.includeMediaUrls ? await signMedia(db, rows) : new Map<string, string>();
  const items = rows.map((r) => toApiMessage(r, { ...authors, signedUrls }));
  const last = rows[rows.length - 1];
  return { items, next_cursor: all.length > opts.limit && last ? encodeCursor([last.created_at, last.id]) : null };
}

// ── Conversas ──────────────────────────────────────────────────────────────

export interface ConversationFilters {
  updatedFrom: string | null;
  updatedTo: string | null;
  closedFrom: string | null;
  closedTo: string | null;
  status: 'open' | 'pending' | 'closed' | null;
  channel: string | null;
  teamId: string | null;
  contactId: string | null;
  phone: string | null;
}

export function parseConversationFilters(p: URLSearchParams): ConversationFilters {
  const status = p.get('status');
  if (status !== null && status !== '' && !['open', 'pending', 'closed'].includes(status)) throw badRequest("'status' deve ser open, pending ou closed");
  const phoneRaw = p.get('phone');
  const phone = phoneRaw ? phoneRaw.replace(/\D/g, '') : null;
  if (phoneRaw && (!phone || phone.length < 8 || phone.length > 15)) throw badRequest("'phone' inválido");
  const f: ConversationFilters = {
    updatedFrom: parseIso(p.get('updated_from'), 'updated_from'),
    updatedTo: parseIso(p.get('updated_to'), 'updated_to'),
    closedFrom: parseIso(p.get('closed_from'), 'closed_from'),
    closedTo: parseIso(p.get('closed_to'), 'closed_to'),
    status: (status || null) as ConversationFilters['status'],
    channel: parseChannel(p.get('channel')),
    teamId: parseUuidParam(p.get('team_id'), 'team_id'),
    contactId: parseUuidParam(p.get('contact_id'), 'contact_id'),
    phone,
  };
  if (f.updatedFrom && f.updatedTo && f.updatedTo <= f.updatedFrom) throw badRequest("'updated_to' deve ser depois de 'updated_from'");
  if (f.closedFrom && f.closedTo && f.closedTo <= f.closedFrom) throw badRequest("'closed_to' deve ser depois de 'closed_from'");
  return f;
}

/** Variações do telefone (com/sem 55) para achar o contato pela chave normalizada. */
export function phoneCandidates(digits: string): string[] {
  const out = new Set([digits]);
  if (digits.startsWith('55') && digits.length >= 12) out.add(digits.slice(2));
  else if (digits.length === 10 || digits.length === 11) out.add(`55${digits}`);
  return [...out];
}

export interface ApiConversation {
  id: string;
  channel: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  team: { id: string; name: string | null } | null;
  assigned_agent: { id: string; name: string | null } | null;
  outcome_tag: { id: string; name: string | null; codigo: number | null } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  message_count: number;
  assignments: Array<{
    at: string;
    from_agent: { id: string; name: string | null } | null;
    to_agent: { id: string; name: string | null } | null;
    from_team: { id: string; name: string | null } | null;
    to_team: { id: string; name: string | null } | null;
    reason: string | null;
  }>;
}

type Row = Record<string, any>;
const ref = (id: unknown, names: Map<string, string | null>) => (typeof id === 'string' && id ? { id, name: names.get(id) ?? null } : null);

const CONVERSATION_COLUMNS = 'id, contact_id, status, channel_type, assigned_agent_id, team_id, outcome_tag_id, created_at, updated_at, first_response_at, closed_at';

export async function loadConversationPage(
  db: Db,
  opts: { accountId: string; filters: ConversationFilters; cursor: string[] | null; limit: number },
): Promise<{ items: ApiConversation[]; next_cursor: string | null }> {
  const { accountId, filters: f, limit } = opts;
  const sortField = f.closedFrom || f.closedTo ? 'closed_at' : 'updated_at';
  if (opts.cursor && opts.cursor[0] !== sortField) throw badRequest("'cursor' não corresponde aos filtros desta consulta");

  let contactIds: string[] | null = f.contactId ? [f.contactId] : null;
  if (f.phone) {
    const { data, error } = await db.from('contacts').select('id').eq('account_id', accountId).in('phone_normalized', phoneCandidates(f.phone)).limit(200);
    if (error) throw error;
    const found = ((data ?? []) as Array<{ id: string }>).map((c) => c.id);
    contactIds = contactIds ? contactIds.filter((id) => found.includes(id)) : found;
  }
  if (contactIds && contactIds.length === 0) return { items: [], next_cursor: null };

  let q = db.from('conversations').select(CONVERSATION_COLUMNS).eq('account_id', accountId);
  if (f.status) q = q.eq('status', f.status);
  if (f.teamId) q = q.eq('team_id', f.teamId);
  if (contactIds) q = q.in('contact_id', contactIds);
  if (f.channel) q = f.channel === 'whatsapp' ? q.or('channel_type.eq.whatsapp,channel_type.is.null') : q.eq('channel_type', f.channel);
  if (f.updatedFrom) q = q.gte('updated_at', f.updatedFrom);
  if (f.updatedTo) q = q.lt('updated_at', f.updatedTo);
  if (f.closedFrom) q = q.gte('closed_at', f.closedFrom);
  if (f.closedTo) q = q.lt('closed_at', f.closedTo);
  if (sortField === 'closed_at') q = q.not('closed_at', 'is', null);
  if (opts.cursor) {
    const [, at, id] = opts.cursor;
    q = q.or(`${sortField}.gt."${at}",and(${sortField}.eq."${at}",id.gt."${id}")`);
  }
  const { data, error } = await q.order(sortField, { ascending: true }).order('id', { ascending: true }).limit(limit + 1);
  if (error) throw error;
  const all = (data ?? []) as Row[];
  const rows = all.slice(0, limit);
  if (rows.length === 0) return { items: [], next_cursor: null };

  const ids = rows.map((r) => r.id as string);
  const [counts, assignments, contacts] = await Promise.all([
    loadMessageCounts(db, accountId, ids),
    loadAssignments(db, accountId, ids),
    loadContacts(db, accountId, rows),
  ]);

  const agentIds = new Set<string>();
  const teamIds = new Set<string>();
  const tagIds = new Set<string>();
  for (const r of rows) {
    if (r.assigned_agent_id) agentIds.add(r.assigned_agent_id);
    if (r.team_id) teamIds.add(r.team_id);
    if (r.outcome_tag_id) tagIds.add(r.outcome_tag_id);
  }
  for (const a of assignments.flat) {
    for (const k of ['from_agent_id', 'to_agent_id'] as const) if (a[k]) agentIds.add(a[k]);
    for (const k of ['from_team_id', 'to_team_id'] as const) if (a[k]) teamIds.add(a[k]);
  }
  const [agents, teams, tags] = await Promise.all([
    nameMap(db, 'profiles', 'user_id', 'full_name', accountId, agentIds),
    nameMap(db, 'teams', 'id', 'name', accountId, teamIds),
    loadTags(db, accountId, tagIds),
  ]);

  const items: ApiConversation[] = rows.map((r) => {
    const contact = contacts.get(r.contact_id);
    const tag = r.outcome_tag_id ? tags.get(r.outcome_tag_id) : null;
    return {
      id: r.id,
      channel: r.channel_type ?? 'whatsapp',
      status: r.status,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      first_response_at: r.first_response_at ? new Date(r.first_response_at).toISOString() : null,
      closed_at: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      team: ref(r.team_id, teams),
      assigned_agent: ref(r.assigned_agent_id, agents),
      outcome_tag: r.outcome_tag_id ? { id: r.outcome_tag_id, name: tag?.name ?? null, codigo: tag?.codigo ?? null } : null,
      contact: contact ? { id: r.contact_id, name: contact.name, phone: contact.phone } : null,
      message_count: counts.get(r.id) ?? 0,
      assignments: (assignments.byConversation.get(r.id) ?? []).map((a) => ({
        at: new Date(a.created_at).toISOString(),
        from_agent: ref(a.from_agent_id, agents),
        to_agent: ref(a.to_agent_id, agents),
        from_team: ref(a.from_team_id, teams),
        to_team: ref(a.to_team_id, teams),
        reason: a.reason ?? null,
      })),
    };
  });
  const last = rows[rows.length - 1];
  const lastValue = last[sortField] as string;
  return { items, next_cursor: all.length > limit ? encodeCursor([sortField, lastValue, last.id]) : null };
}

async function loadMessageCounts(db: Db, accountId: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const { data, error } = await db.rpc('api_v1_conversation_message_counts', { p_account_id: accountId, p_ids: ids });
  if (!error) {
    for (const r of (data ?? []) as Array<{ conversation_id: string; message_count: number | string }>) out.set(r.conversation_id, Number(r.message_count));
    return out;
  }
  if (!isMissingFunction(error)) throw error;
  throw new ApiError('unavailable', 'Extração de conversas indisponível: aplique a migration 330.', 503);
}

async function loadAssignments(db: Db, accountId: string, ids: string[]) {
  const flat: Row[] = [];
  const byConversation = new Map<string, Row[]>();
  const { data, error } = await db
    .from('conversation_assignments')
    .select('conversation_id, from_agent_id, to_agent_id, from_team_id, to_team_id, reason, created_at')
    .eq('account_id', accountId)
    .in('conversation_id', ids)
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) throw error;
  for (const a of (data ?? []) as Row[]) {
    flat.push(a);
    byConversation.set(a.conversation_id, [...(byConversation.get(a.conversation_id) ?? []), a]);
  }
  return { flat, byConversation };
}

/** Contato SÓ com id/nome/telefone: nenhuma outra coluna (CPF, e-mail, empresa…) é lida. */
async function loadContacts(db: Db, accountId: string, rows: Row[]): Promise<Map<string, { name: string | null; phone: string | null }>> {
  const out = new Map<string, { name: string | null; phone: string | null }>();
  const ids = [...new Set(rows.map((r) => r.contact_id as string).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('contacts').select('id, name, phone').eq('account_id', accountId).in('id', ids.slice(i, i + 200));
    if (error) throw error;
    for (const c of (data ?? []) as Row[]) out.set(c.id, { name: c.name ?? null, phone: c.phone ?? null });
  }
  return out;
}

async function nameMap(db: Db, table: string, idCol: string, nameCol: string, accountId: string, ids: Set<string>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.size === 0) return out;
  const { data, error } = await db.from(table).select(`${idCol}, ${nameCol}`).eq('account_id', accountId).in(idCol, [...ids]);
  if (error) throw error;
  for (const r of (data ?? []) as unknown as Row[]) out.set(r[idCol], r[nameCol] ?? null);
  return out;
}

async function loadTags(db: Db, accountId: string, ids: Set<string>): Promise<Map<string, { name: string | null; codigo: number | null }>> {
  const out = new Map<string, { name: string | null; codigo: number | null }>();
  if (ids.size === 0) return out;
  const { data, error } = await db.from('tags').select('id, name, codigo_tabulacao').eq('account_id', accountId).in('id', [...ids]);
  if (error) throw error;
  for (const t of (data ?? []) as Row[]) out.set(t.id, { name: t.name ?? null, codigo: t.codigo_tabulacao ?? null });
  return out;
}
