/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BATCH_MAX_CONVERSATIONS, batchMessagePages, decodeCursor, encodeCursor,
  listConversations, parseBatchPayload, parseEventOptions, parseListOptions,
  parseMessageOptions, readMessagePage,
} from './conversations';
import { parseExportRequest } from './conversation-exports';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const M1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const M2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TIME = '2026-10-13T14:00:00.000Z';

function fakeDb(tables: Record<string, any[]>): SupabaseClient {
  return {
    from(table: string) {
      const checks: Array<(r: any) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let limitValue = Infinity;
      const query: any = {
        select() { return this; },
        eq(key: string, val: unknown) { checks.push(x => x[key] === val); return this; },
        in(key: string, vals: unknown[]) { checks.push(x => vals.includes(x[key])); return this; },
        is(key: string, val: null) { checks.push(x => x[key] === val); return this; },
        not(key: string, _op: string, val: null) { checks.push(x => x[key] !== val); return this; },
        gte(key: string, val: string) { checks.push(x => x[key] >= val); return this; },
        lt(key: string, val: string) { checks.push(x => x[key] < val); return this; },
        order(key: string, options?: { ascending?: boolean }) {
          orders.push([key, options?.ascending ?? true]); return this;
        },
        limit(n: number) { limitValue = n; return this; },
        or(expr: string) {
          // Interpret only the deterministic keyset OR created by the helpers.
          const match = /^created_at\.(gt|lt)\.([^,]+),and\(created_at\.eq\.([^,]+),id\.(gt|lt)\.([^)]+)\)$/.exec(expr);
          if (match) checks.push(row => {
            const [_, direction, at, _, idDirection, id] = match;
            const left = row.created_at.localeCompare(at);
            const right = row.id.localeCompare(id);
            return direction === 'gt' && idDirection === 'gt'
              ? left > 0 || (left === 0 && right > 0)
              : left < 0 || (left === 0 && right < 0);
          });
          return this;
        },
        then(resolve: any, reject?: any) {
          let rows = [...(tables[table] ?? [])].filter(r => checks.every(f => f(r)));
          rows.sort((x, y) => {
            for (const [key, asc] of orders) {
              const cmp = String(x[key] ?? '').localeCompare(String(y[key] ?? ''));
              if (cmp) return cmp * (asc ? 1 : -1);
            }
            return 0;
          });
          return Promise.resolve({ data: rows.slice(0, limitValue), error: null }).then(resolve, reject);
        },
        async maybeSingle() {
          const rows = [...(tables[table] ?? [])].filter(r => checks.every(f => f(r)));
          return { data: rows[0] ?? null, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

function conversation(id = C1, account_id = A) {
  return {
    id, account_id, contact_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    status: 'open', channel_type: 'whatsapp', team_id: null,
    assigned_agent_id: null, created_at: TIME, closed_at: null,
    last_message_at: TIME, first_response_at: null, last_customer_message_at: TIME,
    ai_in_progress_at: null, outcome_tag_id: null, origin_campaign_id: null,
    contact: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Cliente', phone: '5511999990000' },
  };
}
function message(id: string, conv = C1, account_id = A, text = 'mensagem integral') {
  return { id, account_id, conversation_id: conv, sender_id: null,
    sender_type: 'customer', content_type: 'text', content_text: text,
    media_url: null, template_name: null, message_id: null, status: 'received',
    created_at: TIME, received_at: TIME, reply_to_message_id: null,
    interactive_reply_id: null, interactive_payload: null,
    campaign_id: null, attribution_method: null };
}
const url = (suffix = '') => 'https://crm.test/api/v1/conversations' + suffix;

describe('query parsing and bounds', () => {
  it('defaults to full metadata list and limits each page', () => {
    expect(parseListOptions(url()).status).toBe('all');
    expect(parseListOptions(url()).limit).toBe(50);
    expect(parseListOptions(url('?limit=100')).limit).toBe(100);
    expect(() => parseListOptions(url('?limit=101'))).toThrow();
    expect(() => parseListOptions(url('?status=hidden'))).toThrow();
    expect(() => parseListOptions(url('?agent_id=untrusted'))).toThrow();
    expect(() => parseListOptions(url('?channel=telegram'))).toThrow();
    expect(() => parseListOptions(url('?from=2026-02-30'))).toThrow();
    expect(() => parseListOptions(url('?from=2026-10-15&to=2026-10-10'))).toThrow();
  });
  it('rejects tampered cursor but accepts a valid keyset', () => {
    const cursor = encodeCursor({ at: TIME, id: M1 });
    expect(decodeCursor(cursor)).toEqual({ at: TIME, id: M1 });
    expect(() => decodeCursor('garbage!!!')).toThrow();
    expect(() => parseMessageOptions(url('/' + C1 + '/messages?cursor=garbage!!!'))).toThrow();
    expect(parseMessageOptions(url('/' + C1 + '/messages?limit=200')).limit).toBe(200);
    expect(() => parseMessageOptions(url('/' + C1 + '/messages?limit=201'))).toThrow();
  });
  it('validates event types and batch limits', () => {
    expect(parseEventOptions(url('/' + C1 + '/events?type=assignment')).type).toBe('assignment');
    expect(() => parseEventOptions(url('/' + C1 + '/events?type=secrets'))).toThrow();
    expect(() => parseBatchPayload({ conversation_ids: [] })).toThrow();
    expect(() => parseBatchPayload({ conversation_ids: [C1, C1] })).toThrow();
    expect(() => parseBatchPayload({ conversation_ids: Array(BATCH_MAX_CONVERSATIONS + 1).fill(C1) })).toThrow();
    expect(() => parseBatchPayload({ conversation_ids: [C1], limit_per_conversation: 101 })).toThrow();
    expect(() => parseBatchPayload({ conversation_ids: [C1], cursors: { [C2]: 'anything' } })).toThrow();
    expect(parseBatchPayload({ conversation_ids: [C1], limit_per_conversation: 2 }).limit).toBe(2);
  });
});

describe('account isolation and complete transcripts', () => {
  it('filters out records of other tenants at the database boundary', async () => {
    const db = fakeDb({ conversations: [conversation(C1, A), conversation(C2, B)] });
    const page = await listConversations(db, A, parseListOptions(url()));
    expect(page.conversations.map(row => row.id)).toEqual([C1]);
  });
  it('does not reveal a cross-account transcript', async () => {
    const db = fakeDb({ conversations: [conversation(C1, B)], messages: [message(M1, C1, B)] });
    await expect(readMessagePage(db, A, C1, { limit: 100, cursor: null })).rejects.toMatchObject({ status: 404 });
  });
  it('returns untruncated messages and handles equal timestamp keyset pages', async () => {
    const full = 'Texto completo ' + 'X'.repeat(2500);
    const db = fakeDb({ conversations: [conversation()], messages: [message(M1, C1, A, full), message(M2)] });
    const first = await readMessagePage(db, A, C1, { limit: 1, cursor: null });
    expect(first.messages[0].content_text).toBe(full);
    expect(first.messages[0].id).toBe(M1);
    expect(first.has_more).toBe(true);
    const second = await readMessagePage(db, A, C1, { limit: 1, cursor: first.next_cursor });
    expect(second.messages.map(x => x.id)).toEqual([M2]);
    expect(second.next_cursor).toBeNull();
  });
  it('batch is all-or-nothing when any id belongs to another tenant', async () => {
    const db = fakeDb({ conversations: [conversation(C1, A), conversation(C2, B)],
      messages: [message(M1, C1), message(M2, C2, B)] });
    await expect(batchMessagePages(db, A, parseBatchPayload({
      conversation_ids: [C1, C2],
    }))).rejects.toMatchObject({ status: 404 });
  });
  it('returns separate cursors for each conversation without truncating', async () => {
    const db = fakeDb({ conversations: [conversation(C1), conversation(C2)],
      messages: [message(M1, C1), message(M2, C1), message(M1, C2)] });
    const page = await batchMessagePages(db, A, parseBatchPayload({
      conversation_ids: [C1, C2], limit_per_conversation: 1,
    }));
    expect(page.conversations[0].messages).toHaveLength(1);
    expect(page.conversations[0].next_cursor).toBeTruthy();
    expect(page.conversations[1].messages).toHaveLength(1);
    expect(page.conversations[1].next_cursor).toBeNull();
  });
});

describe('export scope and bounded request validation', () => {
  it('requires an explicit date range and enforces max 500 conversations', () => {
    expect(() => parseExportRequest({ from: '2026-10-01' })).toThrow();
    expect(() => parseExportRequest({ from: '2026-10-01', to: '2026-10-02', max_conversations: 501 })).toThrow();
    expect(() => parseExportRequest({ from: '2026-10-01', to: '2026-10-02', account_id: B })).toThrow();
    expect(parseExportRequest({ from: '2026-10-01', to: '2026-10-02' }).maxConversations).toBe(200);
  });
});
