import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { persistOutboundMessage } from "./persist-outbound";

// Banco mínimo: messages com índice único em message_id; conversations.
function fakeDb(initial: { messages: Array<Record<string, unknown>>; conversations: Array<Record<string, unknown>> }) {
  const t = { messages: [...initial.messages], conversations: [...initial.conversations] };
  let seq = 100;
  const deleted: string[] = [];
  function from(table: "messages" | "conversations") {
    const rows = t[table];
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> = {};
    let head = false;
    const b: Record<string, unknown> = {
      select: (_c?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return b; },
      insert: (row: Record<string, unknown>) => { op = "insert"; payload = row; return b; },
      update: (row: Record<string, unknown>) => { op = "update"; payload = row; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      limit: () => b,
      then: (resolve: (v: unknown) => void) => {
        const match = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "insert") {
          if (table === "messages" && rows.some((r) => r.message_id === payload.message_id)) {
            return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
          }
          const row = { id: `m${seq++}`, ...payload };
          rows.push(row);
          return resolve({ data: [row], error: null });
        }
        if (op === "update") { match.forEach((r) => Object.assign(r, payload)); return resolve({ data: null, error: null }); }
        if (op === "delete") {
          match.forEach((r) => { deleted.push(String(r.id)); rows.splice(rows.indexOf(r), 1); });
          return resolve({ data: null, error: null });
        }
        return resolve({ data: head ? null : match, count: match.length, error: null });
      },
    };
    return b;
  }
  return { db: { from } as unknown as SupabaseClient, t, deleted };
}

describe("persistOutboundMessage", () => {
  it("grava normalmente quando não há eco", async () => {
    const { db, t } = fakeDb({ messages: [], conversations: [] });
    const r = await persistOutboundMessage(db, { conversation_id: "c1", message_id: "w1", sender_type: "bot" });
    expect(r.error).toBeNull();
    expect(r.adoptedEcho).toBe(false);
    expect(t.messages).toHaveLength(1);
  });

  it("assume o eco do WAHA: move para a conversa certa como bot e apaga a conversa vazia do eco", async () => {
    const now = new Date().toISOString();
    const { db, t, deleted } = fakeDb({
      messages: [{ id: "echo", conversation_id: "c-eco", message_id: "w1", sender_type: "agent" }],
      conversations: [{ id: "c-eco", created_at: now }, { id: "c1", created_at: now }],
    });
    const r = await persistOutboundMessage(db, { conversation_id: "c1", message_id: "w1", sender_type: "bot", content_text: "Olá" });
    expect(r).toMatchObject({ id: "echo", error: null, adoptedEcho: true });
    expect(t.messages[0]).toMatchObject({ conversation_id: "c1", sender_type: "bot", content_text: "Olá" });
    expect(deleted).toContain("c-eco");
  });

  it("não apaga a conversa do eco se ela tem outras mensagens", async () => {
    const now = new Date().toISOString();
    const { db, deleted } = fakeDb({
      messages: [
        { id: "echo", conversation_id: "c-eco", message_id: "w1" },
        { id: "outra", conversation_id: "c-eco", message_id: "w0" },
      ],
      conversations: [{ id: "c-eco", created_at: now }],
    });
    await persistOutboundMessage(db, { conversation_id: "c1", message_id: "w1", sender_type: "bot" });
    expect(deleted).toEqual([]);
  });

  it("outros erros voltam como erro", async () => {
    const db = {
      from: () => ({ insert: () => ({ select: () => ({ limit: async () => ({ data: null, error: { code: "23502", message: "null" } }) }) }) }),
    } as unknown as SupabaseClient;
    const r = await persistOutboundMessage(db, { conversation_id: "c1", message_id: "w1" });
    expect(r.error?.code).toBe("23502");
    vi.restoreAllMocks();
  });
});
