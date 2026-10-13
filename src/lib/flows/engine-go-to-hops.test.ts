// Decisão do dono (13/10, item 13): o limite de 50 voltas do go_to vale POR MENSAGEM do cliente. O contador zera quando chega mensagem nova,
// e o laço infinito (go_to girando sozinho no mesmo avanço) continua bloqueado em 50.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({ run: null as Record<string, unknown> | null, updates: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
vi.mock("@/lib/ai/responder", () => ({ handleAiAutoResponse: vi.fn(), AI_EMPTY_REPLY_FALLBACK_TEXT: "fallback" }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      let op = "select";
      let payload: Record<string, unknown> = {};
      let head = false;
      const b: Record<string, unknown> = {};
      for (const m of ["eq", "neq", "in", "order", "limit", "filter", "is", "not", "or", "range"]) b[m] = () => b;
      b.select = (_c?: string, o?: { head?: boolean }) => ((head = Boolean(o?.head)), b);
      b.update = (p: Record<string, unknown>) => ((op = "update"), (payload = p), b);
      b.insert = () => ((op = "insert"), b);
      b.maybeSingle = () => b;
      b.single = () => b;
      b.then = (resolve: (v: unknown) => void) => {
        if (table === "flow_runs" && op === "update") dbState.updates.push(payload);
        if (op !== "select") return resolve({ data: null, error: null });
        if (head) return resolve({ data: null, count: 0, error: null });
        return resolve({ data: table === "flow_runs" && dbState.run ? [dbState.run] : [], error: null });
      };
      return b;
    },
  }),
}));

import { advanceFromNodeKey, dispatchInboundToFlows } from "./engine";
import type { FlowNodeRow, FlowRunRow } from "./types";

type Row = Record<string, unknown>;
const FLOW = "66a59213-a13f-4820-bd71-a1dd5967e646";
const node = (node_key: string, node_type: string, config: Row): FlowNodeRow =>
  ({ id: node_key, flow_id: FLOW, node_key, node_type, config, position_x: 0, position_y: 0 }) as unknown as FlowNodeRow;
const runRow = (over: Row = {}): Row => ({
  id: "r1", flow_id: FLOW, account_id: "acc", user_id: "u", contact_id: "ct", conversation_id: "cv", status: "active", current_node_key: "g",
  last_prompt_message_id: null, vars: {}, reprompt_count: 0, hops_count: 0, started_at: "2026-10-06T12:00:00Z", last_advanced_at: "2026-10-06T12:00:00Z",
  ended_at: null, end_reason: null, ...over,
});

function advanceDb() {
  const updates: Row[] = [];
  const b = (table: string) => {
    let op = "select";
    let payload: Row = {};
    const x: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "is", "in", "order", "limit", "filter", "not", "or", "range", "select"]) x[m] = () => x;
    x.update = (p: Row) => ((op = "update"), (payload = p), x);
    x.insert = () => ((op = "insert"), x);
    x.then = (resolve: (v: unknown) => void) => {
      if (table === "flow_runs" && op === "update") updates.push(payload);
      resolve({ data: op === "update" ? [{ id: "r1" }] : [], error: null });
    };
    return x;
  };
  return { db: { from: b, rpc: async () => ({ data: null, error: null }) }, updates };
}

beforeEach(() => {
  dbState.run = null;
  dbState.updates = [];
});

describe("go_to — 50 voltas por mensagem do cliente", () => {
  it("laço infinito continua bloqueado: um go_to que aponta para si mesmo falha o run no 51º salto (go_to_hop_limit_exceeded)", async () => {
    const { db, updates } = advanceDb();
    const r = runRow({ current_node_key: null }) as unknown as FlowRunRow;
    const out = await advanceFromNodeKey(db as never, r, "g", new Map([["g", node("g", "go_to", { target_node_key: "g" })]]));
    expect(out.outcome).toBe("completed");
    expect(r.hops_count).toBe(50);
    expect(updates.some((u) => u.status === "error" && u.end_reason === "go_to_hop_limit_exceeded")).toBe(true);
  });

  it("run que já gastou voltas em mensagens anteriores (49) volta a ter as 50 quando chega mensagem NOVA do cliente", async () => {
    dbState.run = runRow({ hops_count: 49 });
    await dispatchInboundToFlows({ accountId: "acc", contactId: "ct", conversationId: "cv", message: { kind: "text", text: "oi", messageId: "wamid.9" } as never, isFirstInboundMessage: false } as never);
    expect(dbState.updates).toContainEqual({ hops_count: 0 });
  });

  it("run sem voltas gastas não gera gravação extra", async () => {
    dbState.run = runRow({ hops_count: 0 });
    await dispatchInboundToFlows({ accountId: "acc", contactId: "ct", conversationId: "cv", message: { kind: "text", text: "oi", messageId: "wamid.10" } as never, isFirstInboundMessage: false } as never);
    expect(dbState.updates).not.toContainEqual({ hops_count: 0 });
  });
});
