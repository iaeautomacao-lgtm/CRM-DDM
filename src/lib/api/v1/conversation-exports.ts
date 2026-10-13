// Asynchronous, account/key-isolated NDJSON export for full transcripts.
// Sensitive customer content stays inside a private Storage bucket.
import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest, conflict, notFound, payloadTooLarge } from '@/lib/api/v1/respond';
import {
  EXPORT_MAX_CONVERSATIONS, listConversations, parseListOptions,
  readMessagePage, readEventPage,
  type ListOptions,
} from '@/lib/api/v1/conversations';

export const EXPORT_BUCKET = 'conversation-api-exports';
export const EXPORT_MAX_BYTES = 25 * 1024 * 1024;
const EXPORT_MAX_RECORDS = 100_000;
const EXPORT_URL_SECONDS = 600;

export type ExportJobRow = {
  id: string; account_id: string; api_key_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  filters: ListOptions; max_conversations: number; conversation_count: number;
  message_count: number; event_count: number;
  file_bytes: number | null; storage_path: string | null; next_cursor: string | null;
  error_code: string | null; created_at: string; started_at: string | null;
  finished_at: string | null; expires_at: string;
};

export function parseExportRequest(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Expected JSON object');
  const body = input as Record<string, unknown>;
  const allowed = new Set([
    'status','date_field','from','to','team_id','agent_id','contact_id','channel','q','cursor','max_conversations',
  ]);
  if (Object.keys(body).some(k => !allowed.has(k))) throw badRequest('Unknown export filter');
  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    throw badRequest('Export requires from and to in YYYY-MM-DD (Brasilia)');
  }
  const n = body.max_conversations ?? 200;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > EXPORT_MAX_CONVERSATIONS) {
    throw badRequest('max_conversations must be an integer between 1 and ' + EXPORT_MAX_CONVERSATIONS);
  }
  const params = new URLSearchParams();
  for (const key of ['status','date_field','from','to','team_id','agent_id','contact_id','channel','q','cursor']) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    if (typeof body[key] !== 'string') throw badRequest('Invalid filter ' + key);
    params.set(key, body[key]);
  }
  const options = parseListOptions('https://crm.local/api/v1/conversations?' + params.toString());
  options.limit = 100;
  return { filters: options, maxConversations: n };
}

export async function enqueueConversationExport(
  db: SupabaseClient, accountId: string, apiKeyId: string, input: unknown,
) {
  const req = parseExportRequest(input);
  const { count, error: countError } = await db.from('conversation_export_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId).eq('api_key_id', apiKeyId)
    .in('status', ['queued', 'processing']);
  if (countError) throw countError;
  if ((count ?? 0) >= 2) throw conflict('There are already two pending exports for this key');
  const { data, error } = await db.from('conversation_export_jobs')
    .insert({ account_id: accountId, api_key_id: apiKeyId,
      filters: req.filters, max_conversations: req.maxConversations })
    .select('id,status,created_at,expires_at').single();
  if (error) throw error;
  return {
    job_id: data.id, status: data.status, created_at: data.created_at,
    expires_at: data.expires_at,
    status_url: '/api/v1/conversations/exports/' + data.id,
  };
}

export async function getConversationExport(
  db: SupabaseClient, accountId: string, apiKeyId: string, jobId: string,
) {
  const { data, error } = await db.from('conversation_export_jobs')
    .select('id,status,conversation_count,message_count,event_count,file_bytes,next_cursor,error_code,created_at,started_at,finished_at,expires_at,storage_path')
    .eq('id', jobId).eq('account_id', accountId).eq('api_key_id', apiKeyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Export not found');
  const result: Record<string, unknown> = {
    job_id: data.id, status: data.status, conversations: data.conversation_count,
    messages: data.message_count, events: data.event_count,
    bytes: data.file_bytes, error_code: data.error_code,
    created_at: data.created_at, started_at: data.started_at,
    finished_at: data.finished_at, expires_at: data.expires_at,
    next_cursor: data.next_cursor,
  };
  // URL generated only after proving both account and API-key ownership.
  // It expires after ten minutes even if the job lives for 24 hours.
  if (data.status === 'completed' && data.storage_path &&
      Date.parse(data.expires_at) > Date.now()) {
    const { data: signed, error: signError } = await db.storage
      .from(EXPORT_BUCKET).createSignedUrl(data.storage_path, EXPORT_URL_SECONDS, {
        download: 'crm-ddm-conversations-' + data.id + '.ndjson',
      });
    if (signError || !signed) throw signError ?? new Error('Failed to sign export');
    result.download_url = signed.signedUrl;
    result.download_url_expires_in_seconds = EXPORT_URL_SECONDS;
  }
  return result;
}

export class ExportLimitError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

async function assertExportKeyStillActive(
  db: SupabaseClient, accountId: string, apiKeyId: string,
) {
  const { data, error } = await db.from('api_keys')
    .select('id,revoked_at,expires_at,scopes')
    .eq('id', apiKeyId).eq('account_id', accountId).maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at ||
      (data.expires_at && Date.parse(data.expires_at) <= Date.now()) ||
      !Array.isArray(data.scopes) || !data.scopes.includes('conversations:export')) {
    throw new ExportLimitError('api_key_revoked_or_scope_removed');
  }
}

/** Processes one job. Not invoked in normal API requests; cron only. */
export async function generateConversationExport(
  db: SupabaseClient, job: ExportJobRow,
): Promise<{ path: string; bytes: number; conversations: number; messages: number; events: number; nextCursor: string | null }> {
  await assertExportKeyStillActive(db, job.account_id, job.api_key_id);
  const chunks: Buffer[] = [];
  let totalBytes = 0, recordCount = 0, messageCount = 0, eventCount = 0;
  let conversationCount = 0;
  const push = (record: unknown) => {
    const buffer = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    if (totalBytes + buffer.length > EXPORT_MAX_BYTES) {
      throw new ExportLimitError('file_too_large_split_period');
    }
    if (recordCount >= EXPORT_MAX_RECORDS) {
      throw new ExportLimitError('too_many_records_split_period');
    }
    chunks.push(buffer);
    totalBytes += buffer.length;
    recordCount++;
  };
  push({ type: 'export_header', generated_at: new Date().toISOString(),
    format: 'crm-conversations-ndjson-v1', account_id: job.account_id,
    date_basis: job.filters.dateField || 'created_at' });

  let cursor = job.filters.cursor ?? null;
  let more = true;
  // The job is an explicitly bounded page of up to max_conversations; if
  // more exist, next_cursor lets the client create the next page's export.
  while (more && conversationCount < job.max_conversations) {
    const remaining = job.max_conversations - conversationCount;
    const opts: ListOptions = { ...job.filters, cursor, limit: Math.min(remaining, 50) };
    const page = await listConversations(db, job.account_id, opts);
    for (const conv of page.conversations) {
      conversationCount++;
      push({ type: 'conversation', conversation: conv });
      let msgCursor: string | null = null;
      do {
        const messages = await readMessagePage(db, job.account_id, conv.id,
          { limit: 200, cursor: msgCursor });
        for (const message of messages.messages) {
          messageCount++;
          push({ type: 'message', conversation_id: conv.id, message });
        }
        msgCursor = messages.next_cursor;
      } while (msgCursor);

      for (const kind of ['flow', 'assignment', 'status'] as const) {
        let eventCursor: string | null = null;
        do {
          const events = await readEventPage(db, job.account_id, conv.id,
            { type: kind, limit: 200, cursor: eventCursor });
          for (const event of events.events) {
            eventCount++;
            push({ type: 'event', conversation_id: conv.id, event_kind: kind, event });
          }
          eventCursor = events.next_cursor;
        } while (eventCursor);
      }
    }
    cursor = page.next_cursor;
    more = Boolean(cursor);
    if (!page.conversations.length) break;
  }
  const nextCursor = more ? cursor : null;
  push({ type: 'export_footer', conversations: conversationCount,
    messages: messageCount, events: eventCount, next_cursor: nextCursor });
  // A key revoked while this job was being generated must not receive a new file.
  await assertExportKeyStillActive(db, job.account_id, job.api_key_id);
  const storagePath = job.account_id + '/' + job.api_key_id + '/' + job.id + '.ndjson';
  const blob = Buffer.concat(chunks, totalBytes);
  const { error } = await db.storage.from(EXPORT_BUCKET)
    .upload(storagePath, blob, {
      contentType: 'application/x-ndjson', cacheControl: 'no-store', upsert: false,
    });
  if (error) throw error;
  return { path: storagePath, bytes: blob.length, conversations: conversationCount,
    messages: messageCount, events: eventCount, nextCursor };
}

export function validateExportJobId(value: string) {
  // Deliberately do not reveal whether a syntactically valid ID belongs
  // to another account; the subsequent lookup returns the same 404.
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!valid.test(value)) throw badRequest('Invalid export id');
  return value;
}

export function rejectOversizeBody(raw: string, limit = 32768) {
  if (Buffer.byteLength(raw, 'utf8') > limit) throw payloadTooLarge('Export request too large');
}
