// Public, account-scoped CRM conversation reads. The API-key client bypasses
// RLS, so EVERY read is explicitly restricted to the key's account.
import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest, notFound } from '@/lib/api/v1/respond';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MESSAGE_PAGE_MAX = 200;
export const BATCH_MAX_CONVERSATIONS = 10;
export const BATCH_MESSAGE_PAGE_MAX = 100;
export const LIST_PAGE_MAX = 100;
export const EXPORT_MAX_CONVERSATIONS = 500;

type PagePosition = { at: string; id: string };
export type ConversationFilters = {
  status: 'all' | 'active' | 'attending' | 'waiting' | 'open' | 'pending' | 'closed';
  from: string | null;
  to: string | null;
  teamId: string | null;
  agentId: string | null;
  contactId: string | null;
  channel: string | null;
  q: string | null;
};
export type ListOptions = ConversationFilters & { limit: number; cursor: string | null };
export type MessageOptions = { limit: number; cursor: string | null };

function integer(value: unknown, fallback: number, max: number, label: string): number {
  if (value == null || value === '') return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      !/^[0-9]+$/.test(String(value)) || Number(value) < 1 || Number(value) > max) {
    throw badRequest(label + ' must be an integer between 1 and ' + max);
  }
  return Number(value);
}

export function parseUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest('Invalid ' + label);
  return value;
}
function optionalUuid(params: URLSearchParams, name: string): string | null {
  const v = params.get(name);
  return v == null || v === '' ? null : parseUuid(v, name);
}

function dateBoundary(v: string, endExclusive: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest('Dates must use YYYY-MM-DD');
  const start = new Date(v + 'T03:00:00.000Z');
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== v) {
    throw badRequest('Invalid date');
  }
  // The project uses America/Sao_Paulo local dates (UTC-3 in 2026).
  if (endExclusive) start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

export function parseListOptions(input: string): ListOptions {
  const p = new URL(input).searchParams;
  const status = p.get('status') || 'all';
  if (!['all', 'active', 'attending', 'waiting', 'open', 'pending', 'closed'].includes(status)) {
    throw badRequest('Invalid conversation status');
  }
  const from = p.get('from'), to = p.get('to');
  if (from) dateBoundary(from, false);
  if (to) dateBoundary(to, true);
  if (from && to) {
    const days = (Date.parse(to + 'T03:00:00.000Z') - Date.parse(from + 'T03:00:00.000Z')) / 86400000;
    if (days < 0 || days > 365) throw badRequest('Conversation period cannot exceed 366 days');
  }
  const channel = p.get('channel');
  if (channel && !['whatsapp', 'webchat', 'instagram', 'messenger', 'sms'].includes(channel)) {
    throw badRequest('Invalid channel');
  }
  const query = p.get('q')?.trim() || '';
  if (query.length > 80) throw badRequest('q cannot exceed 80 characters');
  // Escape PostgREST .or filter metacharacters; the query is only used
  // for searching names/phones on the contact relationship.
  const q = query.replace(/[,()%*\\]/g, ' ').trim() || null;
  const limit = integer(p.get('limit'), 50, LIST_PAGE_MAX, 'limit');
  const cursor = p.get('cursor');
  if (cursor) decodeCursor(cursor); // fail before any DB read
  return {
    status: status as ConversationFilters['status'], from, to,
    teamId: optionalUuid(p, 'team_id'), agentId: optionalUuid(p, 'agent_id'),
    contactId: optionalUuid(p, 'contact_id'), channel, q, limit, cursor,
  };
}

export function parseMessageOptions(input: string, max = MESSAGE_PAGE_MAX): MessageOptions {
  const p = new URL(input).searchParams;
  const cursor = p.get('cursor');
  if (cursor) decodeCursor(cursor);
  return { limit: integer(p.get('limit'), Math.min(max, 100), max, 'limit'), cursor };
}

/** Keyset cursor: no offset-related gaps on large histories. */
export function encodeCursor(row: PagePosition): string {
  return Buffer.from(JSON.stringify(row), 'utf8').toString('base64url');
}
export function decodeCursor(value: string): PagePosition {
  if (value.length > 280 || !/^[A-Za-z0-9_-]+$/.test(value)) throw badRequest('Invalid cursor');
  try {
    const obj: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') throw new Error('object required');
    const { at, id } = obj as Record<string, unknown>;
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(at) ||
        !Number.isFinite(Date.parse(at)) || typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error('bad cursor fields');
    }
    return { at, id };
  } catch {
    throw badRequest('Invalid cursor');
  }
}

/** To preserve creation order despite identical timestamps. */
function keysetFilter(cursor: string, direction: 'after' | 'before'): string {
  const { at, id } = decodeCursor(cursor);
  const cmp = direction === 'after' ? 'gt' : 'lt';
  return 'created_at.' + cmp + '.' + at + ',and(created_at.eq.' + at + ',id.' + cmp + '.' + id + ')';
}

const CONVERSATION_FIELDS =
  'id,contact_id,status,channel_type,team_id,assigned_agent_id,created_at,closed_at,' +
  'last_message_at,first_response_at,last_customer_message_at,ai_in_progress_at,' +
  'outcome_tag_id,origin_campaign_id';
type ConversationRow = {
  id: string; contact_id: string; status: string; channel_type: string | null;
  team_id: string | null; assigned_agent_id: string | null; created_at: string;
  closed_at: string | null; last_message_at: string | null;
  first_response_at: string | null; last_customer_message_at: string | null;
  ai_in_progress_at: string | null; outcome_tag_id: string | null;
  origin_campaign_id: string | null;
  contact?: { id: string; name: string | null; phone: string | null } |
    Array<{ id: string; name: string | null; phone: string | null }> | null;
};

export function applyConversationFilters(
  // Supabase/PostgREST chain builder has complex generics; preserving its type
  // through a generic wrapper avoids evaluating it before .limit/.order.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  f: ConversationFilters,
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  let q = query.eq('account_id', accountId);
  if (f.status === 'active') q = q.in('status', ['open', 'pending']);
  else if (f.status === 'attending') q = q.in('status', ['open', 'pending']).not('assigned_agent_id', 'is', null);
  else if (f.status === 'waiting') q = q.in('status', ['open', 'pending']).is('assigned_agent_id', null);
  else if (f.status !== 'all') q = q.eq('status', f.status);
  if (f.from) q = q.gte('created_at', dateBoundary(f.from, false));
  if (f.to) q = q.lt('created_at', dateBoundary(f.to, true));
  if (f.teamId) q = q.eq('team_id', f.teamId);
  if (f.agentId) q = q.eq('assigned_agent_id', f.agentId);
  if (f.contactId) q = q.eq('contact_id', f.contactId);
  if (f.channel) q = q.eq('channel_type', f.channel);
  if (f.q) q = q.or('name.ilike.%' + f.q + '%,phone.ilike.%' + f.q + '%', { referencedTable: 'contacts' });
  return q;
}

async function agentNames(db: SupabaseClient, accountId: string, ids: Array<string | null>) {
  const distinct = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!distinct.length) return new Map<string, string>();
  const { data, error } = await db.from('profiles').select('user_id,full_name')
    .eq('account_id', accountId).in('user_id', distinct);
  if (error) throw error;
  return new Map((data ?? []).map(row => [row.user_id as string, row.full_name as string]));
}
async function teamNames(db: SupabaseClient, accountId: string, ids: Array<string | null>) {
  const distinct = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!distinct.length) return new Map<string, string>();
  const { data, error } = await db.from('teams').select('id,name')
    .eq('account_id', accountId).in('id', distinct);
  if (error) throw error;
  return new Map((data ?? []).map(row => [row.id as string, row.name as string]));
}
function extractContact(row: ConversationRow) {
  const v = row.contact;
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
function control(row: ConversationRow) {
  if (row.assigned_agent_id) return 'human';
  const since = row.ai_in_progress_at ? Date.now() - Date.parse(row.ai_in_progress_at) : Infinity;
  return since >= 0 && since <= 90000 ? 'ai_processing' : 'unassigned';
}
async function enrichConversations(db: SupabaseClient, accountId: string, rows: ConversationRow[]) {
  const [names, teams] = await Promise.all([
    agentNames(db, accountId, rows.map(x => x.assigned_agent_id)),
    teamNames(db, accountId, rows.map(x => x.team_id)),
  ]);
  return rows.map(row => {
    const { contact, ...safe } = row;
    return {
      ...safe, contact: extractContact(row),
      assigned_agent_name: row.assigned_agent_id ? names.get(row.assigned_agent_id) ?? null : null,
      team_name: row.team_id ? teams.get(row.team_id) ?? null : null,
      control_state: control(row),
    };
  });
}

export async function listConversations(db: SupabaseClient, accountId: string, f: ListOptions) {
  const relation = f.q ? 'contacts!inner' : 'contacts';
  let q = db.from('conversations')
    .select(CONVERSATION_FIELDS + ',contact:' + relation + '(id,name,phone)');
  q = applyConversationFilters(q, f, accountId);
  if (f.cursor) q = q.or(keysetFilter(f.cursor, 'before'));
  const { data, error } = await q.order('created_at', { ascending: false })
    .order('id', { ascending: false }).limit(f.limit + 1);
  if (error) throw error;
  const all = (data ?? []) as unknown as ConversationRow[];
  const more = all.length > f.limit;
  const rows = all.slice(0, f.limit);
  const last = rows.at(-1);
  return {
    conversations: await enrichConversations(db, accountId, rows),
    next_cursor: more && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
    has_more: more,
  };
}

export async function readConversation(db: SupabaseClient, accountId: string, id: string) {
  parseUuid(id, 'conversation_id');
  const { data, error } = await db.from('conversations')
    .select(CONVERSATION_FIELDS + ',contact:contacts(id,name,phone)')
    .eq('account_id', accountId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Conversation not found');
  const rows = await enrichConversations(db, accountId, [data as unknown as ConversationRow]);
  return rows[0];
}

const MESSAGE_FIELDS =
  'id,conversation_id,sender_type,sender_id,content_type,content_text,media_url,' +
  'template_name,message_id,status,created_at,received_at,reply_to_message_id,' +
  'interactive_reply_id,interactive_payload,campaign_id,attribution_method';
type MessageRow = { id: string; created_at: string; sender_id: string | null; sender_type: string;
  content_type: string; media_url: string | null; [key: string]: unknown };

export async function readMessagePage(
  db: SupabaseClient, accountId: string, conversationId: string, opts: MessageOptions,
) {
  await readConversationExists(db, accountId, conversationId);
  let q = db.from('messages').select(MESSAGE_FIELDS)
    .eq('account_id', accountId).eq('conversation_id', conversationId);
  if (opts.cursor) q = q.or(keysetFilter(opts.cursor, 'after'));
  const { data, error } = await q.order('created_at', { ascending: true })
    .order('id', { ascending: true }).limit(opts.limit + 1);
  if (error) throw error;
  const all = (data ?? []) as unknown as MessageRow[];
  const more = all.length > opts.limit;
  const rows = all.slice(0, opts.limit);
  const names = await agentNames(db, accountId, rows.filter(x => x.sender_type === 'agent').map(x => x.sender_id));
  const last = rows.at(-1);
  return {
    conversation_id: conversationId,
    messages: rows.map(row => ({
      ...row, sender_name: row.sender_type === 'agent' && row.sender_id ? names.get(row.sender_id) ?? null : null,
      media_available: Boolean(row.media_url),
    })),
    next_cursor: more && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
    has_more: more,
  };
}

export async function readConversationExists(db: SupabaseClient, accountId: string, id: string) {
  parseUuid(id, 'conversation_id');
  const { data, error } = await db.from('conversations').select('id')
    .eq('account_id', accountId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Conversation not found');
}

export function parseBatchPayload(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected JSON object');
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.conversation_ids) || !obj.conversation_ids.length ||
      obj.conversation_ids.length > BATCH_MAX_CONVERSATIONS) {
    throw badRequest('conversation_ids must contain 1 to ' + BATCH_MAX_CONVERSATIONS + ' IDs');
  }
  const ids = obj.conversation_ids.map(id => parseUuid(id, 'conversation_id'));
  if (new Set(ids).size !== ids.length) throw badRequest('Duplicate conversation_ids');
  const limit = integer(obj.limit_per_conversation, 100, BATCH_MESSAGE_PAGE_MAX, 'limit_per_conversation');
  const cursors: Record<string, string> = {};
  if (obj.cursors !== undefined) {
    if (!obj.cursors || typeof obj.cursors !== 'object' || Array.isArray(obj.cursors)) {
      throw badRequest('cursors must be an object keyed by conversation UUID');
    }
    for (const [id, value] of Object.entries(obj.cursors)) {
      if (!ids.includes(id) || typeof value !== 'string') throw badRequest('Invalid batch cursor');
      decodeCursor(value);
      cursors[id] = value;
    }
  }
  return { ids, limit, cursors };
}

export async function batchMessagePages(
  db: SupabaseClient, accountId: string, payload: ReturnType<typeof parseBatchPayload>,
) {
  const { data, error } = await db.from('conversations').select('id')
    .eq('account_id', accountId).in('id', payload.ids);
  if (error) throw error;
  const permitted = new Set((data ?? []).map(x => x.id));
  // Consistent 404 for nonexistent and cross-account IDs; do not return
  // any part of a batch containing an inaccessible conversation.
  if (payload.ids.some(id => !permitted.has(id))) throw notFound('Conversation not found');
  const results = [];
  for (const id of payload.ids) {
    // Cap at 10 * 100 = 1000 messages per request, no silent truncation:
    // each item has its own next_cursor until the entire history is read.
    results.push(await readMessagePage(db, accountId, id, {
      limit: payload.limit, cursor: payload.cursors[id] ?? null,
    }));
  }
  return { conversations: results };
}

export function parseEventOptions(url: string) {
  const params = new URL(url).searchParams;
  const type = params.get('type') || 'flow';
  if (!['flow', 'assignment', 'status'].includes(type)) throw badRequest('Invalid event type');
  const page = parseMessageOptions(url);
  return { ...page, type: type as 'flow' | 'assignment' | 'status' };
}

/** Sanitized operational timeline. Never return raw tool payloads,
 * service URLs, tokens or audit IP/user-agent fields. */
export async function readEventPage(
  db: SupabaseClient, accountId: string, conversationId: string,
  opts: ReturnType<typeof parseEventOptions>,
) {
  await readConversationExists(db, accountId, conversationId);
  if (opts.type === 'flow') {
    let q = db.from('flow_run_events')
      .select('id,flow_run_id,event_type,node_key,node_type,status,duration_ms,created_at,run:flow_runs!inner(conversation_id)')
      .eq('account_id', accountId).eq('run.conversation_id', conversationId);
    if (opts.cursor) q = q.or(keysetFilter(opts.cursor, 'after'));
    const { data, error } = await q.order('created_at').order('id').limit(opts.limit + 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Array<{ id: string; created_at: string; run: unknown; [key: string]: unknown }>;
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      conversation_id: conversationId, type: opts.type,
      events: page.map(({ run: _run, ...safe }) => safe),
      next_cursor: rows.length > opts.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
    };
  }
  if (opts.type === 'assignment') {
    let q = db.from('conversation_assignments')
      .select('id,created_at,from_agent_id,to_agent_id,from_team_id,to_team_id,actor_id,reason')
      .eq('account_id', accountId).eq('conversation_id', conversationId);
    if (opts.cursor) q = q.or(keysetFilter(opts.cursor, 'after'));
    const { data, error } = await q.order('created_at').order('id').limit(opts.limit + 1);
    if (error) throw error;
    const rows = data ?? [];
    const page = rows.slice(0, opts.limit), last = page.at(-1);
    return {
      conversation_id: conversationId, type: opts.type, events: page,
      next_cursor: rows.length > opts.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
    };
  }
  let q = db.from('audit_logs')
    .select('id,created_at,action,actor_type,source,changes')
    .eq('account_id', accountId).eq('resource_type', 'conversation').eq('resource_id', conversationId);
  if (opts.cursor) q = q.or(keysetFilter(opts.cursor, 'after'));
  const { data, error } = await q.order('created_at').order('id').limit(opts.limit + 1);
  if (error) throw error;
  const rows = data ?? [];
  const page = rows.slice(0, opts.limit), last = page.at(-1);
  return {
    conversation_id: conversationId, type: opts.type,
    events: page.map(row => {
      const change = (row.changes ?? {}) as Record<string, unknown>;
      return { ...row, changes: {
        status: change.status ?? null, assigned_agent_id: change.assigned_agent_id ?? null,
        outcome_tag_id: change.outcome_tag_id ?? null,
      } };
    }),
    next_cursor: rows.length > opts.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
  };
}
