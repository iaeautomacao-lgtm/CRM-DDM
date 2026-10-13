import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest, notFound } from '@/lib/api/v1/respond';
import { chatMediaPath } from '@/lib/storage/chat-media';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONV_FIELDS = 'id,account_id,contact_id,status,assigned_agent_id,team_id,channel_type,channel_id,origin_campaign_id,created_at,updated_at,closed_at,last_message_at,last_customer_message_at,first_response_at,outcome_tag_id,ai_in_progress_at,contact:contacts(id,name,phone),outcome_tag:tags!outcome_tag_id(id,name)';
const MESSAGE_FIELDS = 'id,conversation_id,sender_type,sender_id,content_type,content_text,media_url,template_name,message_id,status,created_at,received_at,reply_to_message_id,interactive_reply_id,interactive_payload,attribution_method';

export function limitParam(value: string | null, fallback = 50, cap = 100): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw badRequest('limit must be a positive integer');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > cap) throw badRequest('limit must be between 1 and ' + cap);
  return n;
}
export function uuidParam(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw badRequest(label + ' must be a UUID');
  return value;
}
export function timestampParam(value: string | null, label: string): string | null {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw badRequest(label + ' must be an ISO-8601 timestamp');
  return new Date(ts).toISOString();
}
export function dayParam(value: string | null, label: string): string | null {
  if (!value) return null;
  if (!DATE.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) throw badRequest(label + ' must be YYYY-MM-DD');
  return value;
}
export function cursorDecode(raw: string | null): { at: string; id: string } | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { throw badRequest('Invalid cursor'); }
  if (!parsed || typeof parsed !== 'object') throw badRequest('Invalid cursor');
  const x = parsed as { at?: unknown; id?: unknown };
  if (typeof x.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x.at) || typeof x.id !== 'string' || !UUID.test(x.id) || !Number.isFinite(Date.parse(x.at))) throw badRequest('Invalid cursor');
  return { at: x.at, id: x.id };
}
export function cursorEncode(at: string, id: string): string { return Buffer.from(JSON.stringify({ at, id })).toString('base64url'); }
export async function getConversation(db: SupabaseClient, accountId: string, id: string) {
  const { data, error } = await db.from('conversations').select(CONV_FIELDS).eq('account_id', accountId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Conversation not found');
  return data;
}
export async function listConversations(db: SupabaseClient, accountId: string, params: URLSearchParams, snapshotAt?: string) {
  const limit = limitParam(params.get('limit'));
  const cursor = cursorDecode(params.get('cursor'));
  const status = params.get('status');
  if (status && !['open','pending','closed'].includes(status)) throw badRequest('Invalid status');
  const agent = params.get('agent_id'); if (agent) uuidParam(agent,'agent_id');
  const team = params.get('team_id'); if (team) uuidParam(team,'team_id');
  const from = dayParam(params.get('from'),'from');
  const to = dayParam(params.get('to'),'to');
  if (from && to && from > to) throw badRequest('from must not exceed to');
  const channel = params.get('channel_type');
  if (channel && !['whatsapp','webchat','instagram','facebook','messenger'].includes(channel)) throw badRequest('Invalid channel_type');
  let q = db.from('conversations').select(CONV_FIELDS).eq('account_id',accountId)
    .order('created_at',{ascending:true}).order('id',{ascending:true}).limit(limit+1);
  if (status) q=q.eq('status',status);
  if (agent) q=q.eq('assigned_agent_id',agent);
  if (team) q=q.eq('team_id',team);
  if (channel) q=q.eq('channel_type',channel);
  if (from) q=q.gte('created_at',from+'T00:00:00-03:00');
  if (to) q=q.lt('created_at',new Date(Date.parse(to+'T00:00:00-03:00')+86400000).toISOString());
  if (snapshotAt) q=q.lte('created_at',snapshotAt);
  if (snapshotAt) q=q.lte('created_at',snapshotAt);
  if (cursor) q=q.or(`created_at.gt.${cursor.at},and(created_at.eq.${cursor.at},id.gt.${cursor.id})`);
  const {data,error}=await q; if(error)throw error;
  const records=(data??[]) as Array<{created_at:string;id:string;[key:string]:unknown}>;
  const page=records.slice(0,limit);
  const last=page[page.length-1];
  return { items:page, next_cursor:records.length>limit&&last?cursorEncode(last.created_at,last.id):null };
}
export async function listMessages(db: SupabaseClient, accountId: string, conversationId: string, limit: number, cursor: string | null, snapshotAt?: string) {
  await getConversation(db,accountId,conversationId);
  return loadVerifiedMessages(db,accountId,conversationId,limit,cursor,snapshotAt);
}
async function loadVerifiedMessages(db: SupabaseClient, accountId: string, conversationId: string, limit: number, rawCursor: string | null, snapshotAt?: string) {
  const cursor=cursorDecode(rawCursor);
  let q=db.from('messages').select(MESSAGE_FIELDS).eq('account_id',accountId).eq('conversation_id',conversationId)
    .order('created_at',{ascending:true}).order('id',{ascending:true}).limit(limit+1);
  if (cursor) q=q.or(`created_at.gt.${cursor.at},and(created_at.eq.${cursor.at},id.gt.${cursor.id})`);
  const {data,error}=await q;if(error)throw error;
  const items=(data??[]) as Array<{created_at:string;id:string;[key:string]:unknown}>;
  const page=items.slice(0,limit),last=page[page.length-1];
  const safeItems=page.map((message) => ({
    ...message,
    media_download_url: 'media_url' in message && typeof message.media_url === 'string' && chatMediaPath(message.media_url)
      ? `/api/v1/conversations/${conversationId}/messages/${message.id}/media` : null,
  }));
  return { conversation_id:conversationId, items:safeItems, next_cursor:items.length>limit&&last?cursorEncode(last.created_at,last.id):null };
}
export async function batchMessages(db: SupabaseClient, accountId: string, input: unknown) {
  if (!input || typeof input !== 'object') throw badRequest('Expected JSON object');
  const body=input as { conversation_ids?:unknown; limit?:unknown; cursors?:unknown };
  if (!Array.isArray(body.conversation_ids)||body.conversation_ids.length<1||body.conversation_ids.length>20) throw badRequest('conversation_ids must contain 1-20 UUIDs');
  const ids=body.conversation_ids.map(v=>uuidParam(v,'conversation_ids entry'));
  if(new Set(ids).size!==ids.length)throw badRequest('Duplicate conversation_ids');
  const limit=body.limit===undefined?50:limitParam(String(body.limit),50,100);
  const cursors=body.cursors??{};
  if(!cursors||typeof cursors!=='object'||Array.isArray(cursors))throw badRequest('cursors must be an object');
  const {data,error}=await db.from('conversations').select('id').eq('account_id',accountId).in('id',ids);
  if(error)throw error;
  if((data??[]).length!==ids.length)throw notFound('One or more conversations not found');
  // Bound the maximum response to 2,000 messages per batch.
  const result=[];
  for(const id of ids) {
    const cursor=(cursors as Record<string,unknown>)[id]??null;
    if(cursor!==null&&typeof cursor!=='string')throw badRequest('Invalid cursor');
    result.push(await loadVerifiedMessages(db,accountId,id,limit,cursor));
  }
  return { conversations:result };
}
