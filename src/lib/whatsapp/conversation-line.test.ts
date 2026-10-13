// Linha da conversa (decisão do dono 13/10, item 17): a do chamador, a da conversa, ou a única da conta — nunca adivinha.
import { describe, expect, it } from "vitest";

import { resolveConversationLine } from "./conversation-line";

type Row = Record<string, unknown> & { id: string };
function fakeDb(lines: Row[], conv: { config_id?: string | null; waha_session?: string | null } | null, opts: { error?: boolean } = {}) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        limit: () => q,
        then: (ok: (v: unknown) => unknown) => {
          calls.push(`${table}:${filters.map(([c, v]) => `${c}=${v}`).join(",")}`);
          if (opts.error) return Promise.resolve({ data: null, error: { message: "boom" } }).then(ok);
          if (table === "conversations") return Promise.resolve({ data: conv ? [conv] : [], error: null }).then(ok);
          const rows = lines.filter((l) => filters.every(([c, v]) => (l as Record<string, unknown>)[c] === v));
          return Promise.resolve({ data: rows.slice(0, 2), error: null }).then(ok);
        },
      };
      return q;
    },
  };
  return { db: db as never, calls };
}

const L1 = { id: "L1", account_id: "acc", waha_session: null, user_id: "dono-1" };
const L2 = { id: "L2", account_id: "acc", waha_session: "s2", user_id: "dono-2" };

describe("resolveConversationLine", () => {
  it("linha do chamador (configId), escopada pela conta", async () => {
    const f = fakeDb([L1, L2], null);
    expect(await resolveConversationLine(f.db, { accountId: "acc", conversationId: "c", configId: "L2" })).toEqual({ line: L2, reason: "configured" });
    expect(await resolveConversationLine(f.db, { accountId: "outra", conversationId: "c", configId: "L2" })).toEqual({ line: null, reason: "not_found" });
  });

  it("sem configId: a linha da conversa (config_id) — conta com várias linhas", async () => {
    const r = await resolveConversationLine(fakeDb([L1, L2], { config_id: "L2" }).db, { accountId: "acc", conversationId: "c" });
    expect(r).toEqual({ line: L2, reason: "conversation" });
  });

  it("conversa antiga do WAHA sem config_id: a linha da waha_session", async () => {
    const r = await resolveConversationLine(fakeDb([L1, L2], { config_id: null, waha_session: "s2" }).db, { accountId: "acc", conversationId: "c" });
    expect(r).toEqual({ line: L2, reason: "conversation" });
  });

  it("sem pista: a única linha da conta; com várias, não adivinha", async () => {
    expect(await resolveConversationLine(fakeDb([L1], { config_id: null }).db, { accountId: "acc", conversationId: "c" })).toEqual({ line: L1, reason: "only_line" });
    expect(await resolveConversationLine(fakeDb([L1, L2], { config_id: null }).db, { accountId: "acc", conversationId: "c" })).toEqual({ line: null, reason: "ambiguous" });
    expect(await resolveConversationLine(fakeDb([], null).db, { accountId: "acc", conversationId: null })).toEqual({ line: null, reason: "not_found" });
  });

  it("erro de leitura vira reason error (sem lançar)", async () => {
    expect(await resolveConversationLine(fakeDb([L1], null, { error: true }).db, { accountId: "acc", conversationId: "c" })).toMatchObject({ line: null, reason: "error" });
  });
});
