import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));

import { AI_STALL_HANDOFF_REASON, AI_STALL_REASON, stallWindow, sweepStalledAiConversations } from "./ai-watchdog";

type Row = Record<string, unknown>;

// Banco mínimo com os filtros que o vigia usa.
function fakeDb(tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string; payload: Row; filters: Array<[string, string, unknown]> }> = [];
  function from(table: string) {
    let op = "select";
    let payload: Row = {};
    const filters: Array<[string, string, unknown]> = [];
    const apply = (rows: Row[]) =>
      rows.filter((r) =>
        filters.every(([kind, col, v]) => {
          const x = r[col];
          if (kind === "eq") return x === v;
          if (kind === "neq") return x !== v;
          if (kind === "is") return x === v;
          if (kind === "lt") return String(x) < String(v);
          if (kind === "gt") return String(x) > String(v);
          return true;
        }),
      );
    const b: Record<string, unknown> = {
      select: () => b,
      order: () => b,
      limit: () => b,
      update: (p: Row) => { op = "update"; payload = p; return b; },
      insert: (p: Row) => { op = "insert"; payload = p; return b; },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b; },
      neq: (c: string, v: unknown) => { filters.push(["neq", c, v]); return b; },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return b; },
      lt: (c: string, v: unknown) => { filters.push(["lt", c, v]); return b; },
      gt: (c: string, v: unknown) => { filters.push(["gt", c, v]); return b; },
      then: (resolve: (v: unknown) => void) => {
        const rows = tables[table] ?? [];
        if (op === "select") return resolve({ data: apply(rows), error: null });
        writes.push({ table, op, payload, filters: [...filters] });
        if (op === "update") {
          const hit = apply(rows);
          hit.forEach((r) => Object.assign(r, payload));
          return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
        }
        rows.push(payload);
        return resolve({ data: null, error: null });
      },
    };
    return b;
  }
  return { db: { from } as unknown as SupabaseClient, writes, tables };
}

const now = new Date("2026-10-05T20:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

// Conversa parada há 200 s (acima do padrão de 180 s), run no nó de IA.
function stalledTables(over: { conv?: Row; run?: Row } = {}) {
  return {
    conversations: [
      { id: "c1", account_id: "a", status: "open", assigned_agent_id: null, last_customer_message_at: ago(200), ...over.conv },
    ] as Row[],
    messages: [{ id: "m1", conversation_id: "c1", sender_type: "customer", created_at: ago(200) }] as Row[],
    flow_runs: [
      { id: "r1", flow_id: "f", conversation_id: "c1", status: "active", current_node_key: "agente_ddm", ...over.run },
    ] as Row[],
    flow_nodes: [
      { flow_id: "f", node_key: "agente_ddm", node_type: "ai_agent" },
      { flow_id: "f", node_key: "menu", node_type: "send_buttons" },
    ] as Row[],
    flow_run_events: [] as Row[],
    ai_decisions: [] as Row[],
  };
}

describe("sweepStalledAiConversations", () => {
  it("(d) modelo lento: heartbeat renovado há 40 s — não transfere", async () => {
    const { db, tables } = fakeDb(stalledTables({ conv: { ai_in_progress_at: ago(40) } }));
    expect(await sweepStalledAiConversations(db, now)).toBe(0);
    expect(tables.flow_runs[0].status).toBe("active");
    expect(tables.conversations[0].status).toBe("open");
    expect(tables.ai_decisions).toHaveLength(0);
  });

  it("heartbeat velho (> 2 min, processo caiu no meio): transfere", async () => {
    const { db } = fakeDb(stalledTables({ conv: { ai_in_progress_at: ago(130) } }));
    expect(await sweepStalledAiConversations(db, now)).toBe(1);
  });

  it("run parado em nó que não é de IA (botões/coleta) não é varrido", async () => {
    const { db, tables } = fakeDb(stalledTables({ run: { current_node_key: "menu" } }));
    expect(await sweepStalledAiConversations(db, now)).toBe(0);
    expect(tables.flow_runs[0].status).toBe("active");
  });

  it("dentro da janela de 180 s não mexe (antes: 90 s)", async () => {
    const { db } = fakeDb(stalledTables({ conv: { last_customer_message_at: ago(120) } }));
    expect(await sweepStalledAiConversations(db, now)).toBe(0);
  });

  it("transfere para humano a conversa com IA parada", async () => {
    const { db, tables } = fakeDb(stalledTables());
    expect(await sweepStalledAiConversations(db, now)).toBe(1);
    expect(tables.flow_runs[0]).toMatchObject({ status: "handed_off", end_reason: AI_STALL_REASON });
    expect(tables.conversations[0]).toMatchObject({ status: "pending" });
    expect(tables.flow_run_events[0]).toMatchObject({ flow_run_id: "r1", event_type: "handoff" });
    expect(tables.ai_decisions).toHaveLength(1);
    expect(tables.ai_decisions[0]).toMatchObject({
      flow_run_id: "r1",
      conversation_id: "c1",
      decision_type: "handoff",
      needs_human: true,
      handoff_reason: AI_STALL_HANDOFF_REASON,
      handoff_subreason: "WATCHDOG_SEM_RESPOSTA",
    });
  });

  it("não mexe se alguém já respondeu depois do cliente", async () => {
    const t = stalledTables();
    t.messages = [{ id: "m2", conversation_id: "c1", sender_type: "bot", created_at: ago(100) }];
    const { db, tables } = fakeDb(t);
    expect(await sweepStalledAiConversations(db, now)).toBe(0);
    expect(tables.flow_runs[0].status).toBe("active");
  });

  it("não mexe sem fluxo ativo (conversa de humano)", async () => {
    const { db } = fakeDb(stalledTables({ run: { status: "completed" } }));
    expect(await sweepStalledAiConversations(db, now)).toBe(0);
  });

  it("migration 152 pendente: cai para a consulta sem heartbeat", async () => {
    const t = stalledTables();
    const { db: inner } = fakeDb(t);
    let first = true;
    const db = {
      from(table: string) {
        const b = (inner as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
        if (table !== "conversations") return b;
        const origSelect = b.select as (c: string) => unknown;
        b.select = (cols: string) => {
          if (first && cols.includes("ai_in_progress_at")) {
            first = false;
            const failing: Record<string, unknown> = {};
            for (const k of ["eq", "is", "lt", "gt", "order", "limit"]) failing[k] = () => failing;
            failing.then = (resolve: (v: unknown) => void) =>
              resolve({ data: null, error: { message: 'column conversations.ai_in_progress_at does not exist' } });
            return failing;
          }
          return origSelect(cols);
        };
        return b;
      },
    } as unknown as SupabaseClient;
    expect(await sweepStalledAiConversations(db, now)).toBe(1);
  });

  it("janela padrão: 180 s a 30 min", () => {
    const w = stallWindow(now);
    expect(w.stalledBefore).toBe(ago(180));
    expect(w.notOlderThan).toBe(ago(30 * 60));
  });
});
